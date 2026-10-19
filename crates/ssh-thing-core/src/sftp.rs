//! SFTP file upload over an already-open SSH session.
//!
//! Uploads reuse the live [`russh`] handle: a second session channel is opened
//! and switched to the `sftp` subsystem, so the user never authenticates twice
//! and the existing PTY channel keeps running untouched.
//!
//! Two details drive the shape of this module:
//!
//! * `russh`'s `request_subsystem` only *sends* the request — it never observes
//!   the reply. A server without SFTP would otherwise hang forever, so
//!   [`open_sftp`] awaits the acknowledgement under a bounded timeout.
//! * `russh-sftp` is transport-agnostic; it consumes any
//!   `AsyncRead + AsyncWrite + Unpin + Send + 'static`, which is exactly what
//!   `russh`'s `Channel::into_stream()` produces.
//!
//! Nothing here touches the filesystem of the local machine beyond reading the
//! file being uploaded, and nothing is persisted.

use std::path::Path;

use russh::client::{Handle, Handler};
use russh::ChannelMsg;
use russh_sftp::client::error::Error as SftpError;

use russh_sftp::protocol::{OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout, Duration};

use crate::model::{MAX_UPLOAD_BYTES, UPLOAD_PROGRESS_STEP_BYTES};

/// Re-exported so consumers (the Tauri binary) can name the session type
/// without depending on `russh-sftp` directly.
pub use russh_sftp::client::SftpSession;

/// Bytes read from disk and handed to the SFTP writer per iteration.
///
/// Small enough that a huge file never sits in memory, large enough that a
/// 100 MB transfer is not dominated by per-chunk overhead. `russh-sftp` clamps
/// each underlying write to the server's advertised `limits@openssh.com`
/// length, so this does not need to know the negotiated packet size.
const CHUNK_SIZE: usize = 64 * 1024;

/// Result of one file's transfer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadOutcome {
    Uploaded {
        bytes_sent: u64,
    },
    /// The remote file existed and overwrite was off. Nothing was written.
    SkippedExists,
}

// ------------------------------------------------------------ path handling

/// Collapse repeated slashes and drop a trailing slash, preserving root.
fn collapse_slashes(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut last_was_slash = false;

    for ch in path.chars() {
        if ch == '/' {
            if last_was_slash {
                continue;
            }
            last_was_slash = true;
        } else {
            last_was_slash = false;
        }
        out.push(ch);
    }

    if out.len() > 1 && out.ends_with('/') {
        out.pop();
    }

    if out.is_empty() {
        "/".to_string()
    } else {
        out
    }
}

/// Turn what the user typed into an absolute remote directory.
///
/// `~` and `~/sub` expand against `home` (the server's home directory, resolved
/// over SFTP at upload time). Relative paths resolve against `home` too, which
/// is the least surprising reading of `logs`. Absolute paths pass through.
pub fn normalize_remote_dir(input: &str, home: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Enter a destination directory on the server.".to_string());
    }

    let home = {
        let cleaned = collapse_slashes(home.trim());
        if cleaned.is_empty() {
            ".".to_string()
        } else {
            cleaned
        }
    };

    if trimmed == "~" {
        return Ok(home);
    }

    if let Some(rest) = trimmed.strip_prefix('~') {
        if !rest.starts_with('/') {
            return Err(format!(
                "Unsupported destination \"{}\": use ~, ~/subdirectory, or an absolute path.",
                trimmed
            ));
        }
        return Ok(collapse_slashes(&format!(
            "{}{}",
            home.trim_end_matches('/'),
            rest
        )));
    }

    if trimmed.starts_with('/') {
        return Ok(collapse_slashes(trimmed));
    }

    // Relative: resolve against the server's home directory.
    Ok(collapse_slashes(&format!(
        "{}/{}",
        home.trim_end_matches('/'),
        trimmed
    )))
}

/// Join a directory and a file name with exactly one separating slash.
pub fn join_remote(dir: &str, name: &str) -> String {
    let name = name.trim_start_matches('/');
    if dir.is_empty() || dir == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// Human-readable byte count, matching how the UI labels file sizes.
pub fn format_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = KIB * 1024;
    const GIB: u64 = MIB * 1024;

    if bytes >= GIB {
        format!("{:.1} GB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.1} MB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KB", bytes as f64 / KIB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// Reject a file that exceeds the per-file ceiling, before any bytes are sent.
pub fn check_upload_size(size: u64) -> Result<(), String> {
    if size > MAX_UPLOAD_BYTES {
        return Err(format!(
            "File is {} but the per-file limit is {}. Send it in pieces or use scp.",
            format_bytes(size),
            format_bytes(MAX_UPLOAD_BYTES)
        ));
    }
    Ok(())
}

/// Turn an SFTP protocol status into something a person can act on.
///
/// The server-supplied message is appended when it adds information; servers
/// often return a bare "Failure" that explains nothing on its own.
pub fn describe_sftp_error(status: StatusCode, message: &str) -> String {
    let base = match status {
        StatusCode::NoSuchFile => {
            "The destination directory does not exist on the server.".to_string()
        }
        StatusCode::PermissionDenied => {
            "The server account cannot write there. Check the directory's ownership and permissions.".to_string()
        }
        StatusCode::OpUnsupported => {
            "The server does not support that SFTP operation.".to_string()
        }
        StatusCode::NoConnection | StatusCode::ConnectionLost => {
            "The connection dropped during the transfer. Reconnect and try again.".to_string()
        }
        StatusCode::Failure => "The server rejected the request.".to_string(),
        _ => format!("The server returned an SFTP error ({}).", status),
    };

    let detail = message.trim();
    // Servers commonly echo the status name ("Failure", "Permission denied")
    // or repeat our own sentence. Neither adds anything for the reader.
    let redundant = detail.is_empty()
        || detail.eq_ignore_ascii_case(base.as_str())
        || detail.eq_ignore_ascii_case(&status.to_string());

    if redundant {
        base
    } else {
        format!("{} Server said: {}", base, detail)
    }
}

/// Pull the protocol status out of a client error, when there is one.
fn status_of(error: &SftpError) -> Option<StatusCode> {
    match error {
        SftpError::Status(status) => Some(status.status_code),
        _ => None,
    }
}

// -------------------------------------------------------------- transport

/// Open an SFTP subsystem channel on an existing session.
///
/// `ack_timeout_seconds` bounds the wait for the server to accept the
/// subsystem; `io_timeout_seconds` bounds each subsequent SFTP request.
///
/// The returned session owns its own channel and is independent of the PTY
/// channel, so the caller can drop the session registry lock as soon as this
/// returns.
pub async fn open_sftp<H>(
    handle: &Handle<H>,
    ack_timeout_seconds: u64,
    io_timeout_seconds: u64,
) -> Result<SftpSession, String>
where
    H: Handler,
{
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open SFTP channel: {}", e))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Failed to request the SFTP subsystem: {}", e))?;

    // `request_subsystem` does not wait for the reply, so do it here. Without
    // this, a server that has no SFTP subsystem leaves the transfer hanging.
    match timeout(
        Duration::from_secs(ack_timeout_seconds.max(1)),
        channel.wait(),
    )
    .await
    {
        Ok(Some(ChannelMsg::Success)) => {}
        Ok(Some(ChannelMsg::Failure)) => {
            return Err(
                "This server refused the SFTP subsystem. It may not have SFTP enabled \
                 (common on embedded devices and minimal sshd builds)."
                    .to_string(),
            )
        }
        Ok(Some(_)) => {
            // An unexpected leading message is not fatal; the SFTP handshake
            // below will fail with a better error if the subsystem is unusable.
        }
        Ok(None) => {
            return Err(
                "The SSH channel closed before the server accepted the SFTP subsystem.".to_string(),
            )
        }
        Err(_) => {
            return Err(format!(
                "Timed out after {} seconds waiting for the server to accept the SFTP subsystem.",
                ack_timeout_seconds.max(1)
            ))
        }
    }

    SftpSession::new_opts(channel.into_stream(), Some(io_timeout_seconds.max(1)))
        .await
        .map_err(|e| format!("Failed to start SFTP: {}", e))
}

// --------------------------------------------------------------- transfer

/// Stream one local file to `remote_path`, reporting progress as it goes.
///
/// Never buffers the whole file: bytes move in [`CHUNK_SIZE`] pieces, so a
/// multi-hundred-megabyte upload costs the same memory as a tiny one.
///
/// When `overwrite` is false the open uses `EXCLUDE`, so a file that appears
/// between the existence check and the open is still never silently replaced.
pub async fn upload_file(
    sftp: &SftpSession,
    local: &Path,
    remote_path: &str,
    overwrite: bool,
    mut on_progress: impl FnMut(u64),
) -> Result<UploadOutcome, String> {
    if !overwrite
        && sftp
            .try_exists(remote_path)
            .await
            .map_err(|e| format!("Failed to check whether {} exists: {}", remote_path, e))?
    {
        return Ok(UploadOutcome::SkippedExists);
    }

    let flags = if overwrite {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    } else {
        OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE
    };

    let mut remote = match sftp.open_with_flags(remote_path, flags).await {
        Ok(file) => file,
        Err(error) => {
            return match status_of(&error) {
                Some(status) => Err(describe_sftp_error(status, &error.to_string())),
                None => Err(format!("Failed to create {}: {}", remote_path, error)),
            }
        }
    };

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("Failed to open {}: {}", local.display(), e))?;

    let mut buffer = vec![0u8; CHUNK_SIZE];
    let mut sent: u64 = 0;
    let mut last_reported: u64 = 0;

    loop {
        let read = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read {}: {}", local.display(), e))?;

        if read == 0 {
            break;
        }

        remote
            .write_all(&buffer[..read])
            .await
            .map_err(|e| format!("Upload failed while writing {}: {}", remote_path, e))?;

        sent += read as u64;

        if sent - last_reported >= UPLOAD_PROGRESS_STEP_BYTES {
            on_progress(sent);
            last_reported = sent;
        }
    }

    remote
        .sync_all()
        .await
        .map_err(|e| format!("Failed to flush {} on the server: {}", remote_path, e))?;
    let _ = remote.shutdown().await;

    // Always report the final position so the bar settles exactly.
    on_progress(sent);

    Ok(UploadOutcome::Uploaded { bytes_sent: sent })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/ken";

    #[test]
    fn empty_destination_is_refused() {
        assert!(normalize_remote_dir("", HOME).is_err());
        assert!(normalize_remote_dir("   ", HOME).is_err());
    }

    #[test]
    fn tilde_expands_to_home() {
        assert_eq!(normalize_remote_dir("~", HOME).unwrap(), HOME);
        assert_eq!(normalize_remote_dir("  ~  ", HOME).unwrap(), HOME);
    }

    #[test]
    fn tilde_subdirectory_expands_against_home() {
        assert_eq!(
            normalize_remote_dir("~/logs", HOME).unwrap(),
            "/home/ken/logs"
        );
        assert_eq!(
            normalize_remote_dir("~/logs/2026", HOME).unwrap(),
            "/home/ken/logs/2026"
        );
    }

    #[test]
    fn relative_paths_resolve_against_home() {
        assert_eq!(
            normalize_remote_dir("logs", HOME).unwrap(),
            "/home/ken/logs"
        );
        assert_eq!(
            normalize_remote_dir("./logs", HOME).unwrap(),
            "/home/ken/./logs"
        );
    }

    #[test]
    fn absolute_paths_pass_through_unchanged() {
        assert_eq!(normalize_remote_dir("/tmp/x", HOME).unwrap(), "/tmp/x");
        assert_eq!(normalize_remote_dir("/tmp/x/", HOME).unwrap(), "/tmp/x");
        assert_eq!(normalize_remote_dir("/", HOME).unwrap(), "/");
    }

    #[test]
    fn repeated_and_trailing_slashes_collapse() {
        assert_eq!(
            normalize_remote_dir("/tmp//x///y/", HOME).unwrap(),
            "/tmp/x/y"
        );
        assert_eq!(
            normalize_remote_dir("~/a//b/", HOME).unwrap(),
            "/home/ken/a/b"
        );
    }

    #[test]
    fn bare_tilde_name_is_rejected_with_guidance() {
        let error = normalize_remote_dir("~ken/logs", HOME).unwrap_err();
        assert!(error.contains("~/subdirectory"));
    }

    #[test]
    fn home_with_trailing_slash_does_not_double_up() {
        assert_eq!(
            normalize_remote_dir("~/logs", "/home/ken/").unwrap(),
            "/home/ken/logs"
        );
    }

    #[test]
    fn join_remote_uses_exactly_one_separator() {
        assert_eq!(join_remote("/home/ken", "notes.txt"), "/home/ken/notes.txt");
        assert_eq!(
            join_remote("/home/ken/", "notes.txt"),
            "/home/ken/notes.txt"
        );
        assert_eq!(join_remote("/", "notes.txt"), "/notes.txt");
        assert_eq!(join_remote("", "notes.txt"), "/notes.txt");
    }

    #[test]
    fn size_limit_is_inclusive_and_reported_in_units() {
        assert!(check_upload_size(MAX_UPLOAD_BYTES).is_ok());
        assert!(check_upload_size(0).is_ok());

        let error = check_upload_size(MAX_UPLOAD_BYTES + 1).unwrap_err();
        assert!(error.contains("2.0 GB"), "unexpected message: {}", error);
    }

    #[test]
    fn format_bytes_scales_through_units() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GB");
    }

    #[test]
    fn sftp_statuses_produce_distinct_actionable_text() {
        let denied = describe_sftp_error(StatusCode::PermissionDenied, "");
        let missing = describe_sftp_error(StatusCode::NoSuchFile, "");
        let unsupported = describe_sftp_error(StatusCode::OpUnsupported, "");

        assert!(denied.contains("cannot write"));
        assert!(missing.contains("does not exist"));
        assert!(unsupported.contains("does not support"));

        assert_ne!(denied, missing);
        assert_ne!(missing, unsupported);
    }

    #[test]
    fn server_detail_is_appended_but_not_duplicated() {
        let with_detail = describe_sftp_error(StatusCode::NoSuchFile, "no such directory");
        assert!(with_detail.contains("Server said: no such directory"));

        // A server echoing the same thing adds nothing.
        let bare = describe_sftp_error(StatusCode::Failure, "Failure");
        assert!(!bare.contains("Server said"));
    }

    #[test]
    fn connection_loss_gets_its_own_message() {
        let lost = describe_sftp_error(StatusCode::ConnectionLost, "");
        assert!(lost.contains("connection dropped"));
    }
}

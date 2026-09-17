//! SSH connect, host-key policy, and one-shot command execution.
//!
//! The desktop app and the CLI share this module. The only difference between
//! them is the [`Handler`] they pass in:
//!
//! * the desktop uses its interactive handler, which prompts the user and can
//!   learn a new host key;
//! * the CLI uses [`StrictHostKeyHandler`], which fails closed and never
//!   teaches the store a new key.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use russh::client::{Config, Handle, Handler};
use russh::{keys, ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::time::{timeout, Duration};

use crate::model::{
    AuthMethod, HostKeyMismatch, KnownHost, SecretKind, DEFAULT_CONNECT_TIMEOUT_SECONDS,
    MAX_COMMAND_TIMEOUT_SECONDS, MAX_OUTPUT_BYTES, MIN_COMMAND_TIMEOUT_SECONDS, TRUNCATION_MARKER,
};
use crate::secrets;
use crate::store;

pub const KEEPALIVE_INTERVAL_SECONDS: u64 = 15;
pub const KEEPALIVE_MAX: usize = 3;
pub const DISCONNECT_TIMEOUT_SECONDS: u64 = 2;

/// russh client config used by both binaries.
pub fn client_config() -> Arc<Config> {
    Arc::new(Config {
        keepalive_interval: Some(Duration::from_secs(KEEPALIVE_INTERVAL_SECONDS)),
        keepalive_max: KEEPALIVE_MAX,
        ..Config::default()
    })
}

/// Connect and authenticate, returning a live session.
///
/// Generic over the handler so the desktop keeps its interactive host-key
/// prompt while the CLI gets fail-closed behaviour, with no duplicated
/// connect/authenticate code between them.
pub async fn connect<H>(
    handler: H,
    host: &str,
    port: u16,
    user: &str,
    auth: &AuthMethod,
    timeout_seconds: Option<u64>,
) -> Result<Handle<H>, String>
where
    H: Handler + Send + 'static,
    H::Error: std::fmt::Display,
{
    let addr = format!("{}:{}", host, port);

    let connect_timeout = Duration::from_secs(
        timeout_seconds
            .unwrap_or(DEFAULT_CONNECT_TIMEOUT_SECONDS)
            .max(1),
    );
    let mut session = timeout(
        connect_timeout,
        russh::client::connect(client_config(), addr, handler),
    )
    .await
    .map_err(|_| {
        format!(
            "Failed to connect: timed out after {} seconds",
            connect_timeout.as_secs()
        )
    })?
    .map_err(|e| format!("Failed to connect: {}", e))?;

    authenticate(&mut session, user, auth).await?;

    Ok(session)
}

async fn authenticate<H: Handler>(
    session: &mut Handle<H>,
    user: &str,
    auth: &AuthMethod,
) -> Result<(), String> {
    match auth {
        AuthMethod::SecretRef { secret_id, kind } => match kind {
            SecretKind::Password => {
                let password = secrets::get_secret(secret_id)?;
                let accepted = session
                    .authenticate_password(user, &password)
                    .await
                    .map_err(|e| format!("Authentication failed: {}", e))?;
                if !accepted {
                    return Err("Password authentication failed".to_string());
                }
                Ok(())
            }
            SecretKind::PrivateKey => {
                let key_data = secrets::get_secret(secret_id)?;
                authenticate_with_key(session, user, &key_data).await
            }
        },
        AuthMethod::Password { password } => {
            let accepted = session
                .authenticate_password(user, password)
                .await
                .map_err(|e| format!("Authentication failed: {}", e))?;
            if !accepted {
                return Err("Password authentication failed".to_string());
            }
            Ok(())
        }
        AuthMethod::Key { private_key } => authenticate_with_key(session, user, private_key).await,
    }
}

async fn authenticate_with_key<H: Handler>(
    session: &mut Handle<H>,
    user: &str,
    key_data: &str,
) -> Result<(), String> {
    let key_pair = keys::decode_secret_key(key_data, None)
        .map_err(|e| format!("Failed to decode private key: {}", e))?;
    let accepted = session
        .authenticate_publickey(user, Arc::new(key_pair))
        .await
        .map_err(|e| format!("Key authentication failed: {}", e))?;
    if !accepted {
        return Err("Key authentication failed".to_string());
    }
    Ok(())
}

/// Best-effort, bounded disconnect. Never fails the caller.
pub async fn disconnect_quiet<H: Handler>(session: Handle<H>) {
    let _ = timeout(
        Duration::from_secs(DISCONNECT_TIMEOUT_SECONDS),
        session.disconnect(Disconnect::ByApplication, "disconnected", "en"),
    )
    .await;
}

// ------------------------------------------------------------- host keys

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostKeyDenial {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub stored_fingerprint: Option<String>,
}

impl HostKeyDenial {
    /// Whether the host is known but the key changed.
    pub fn is_mismatch(&self) -> bool {
        self.stored_fingerprint.is_some()
    }

    /// Actionable, user-facing explanation.
    pub fn message(&self) -> String {
        match &self.stored_fingerprint {
            Some(stored) => format!(
                "Host key mismatch for {}:{} — refusing to connect. Stored {} ({}), received {} ({}). If the server was rebuilt, remove its entry from known hosts in the SSH THING desktop app and connect once to re-approve it.",
                self.host, self.port, stored, self.key_type, self.fingerprint, self.key_type
            ),
            None => format!(
                "Unknown host key for {}:{} ({}, {}) — refusing to connect. Open SSH THING, connect to this server once, and approve the key. The CLI never trusts a new key on its own.",
                self.host, self.port, self.key_type, self.fingerprint
            ),
        }
    }
}

/// Host-key policy that accepts only keys already present in
/// `known_hosts.json`. Unknown hosts and changed keys both fail.
pub struct StrictHostKeyHandler {
    app_dir: PathBuf,
    host: String,
    port: u16,
    denial: Arc<Mutex<Option<HostKeyDenial>>>,
}

impl StrictHostKeyHandler {
    pub fn new(app_dir: impl Into<PathBuf>, host: impl Into<String>, port: u16) -> Self {
        Self {
            app_dir: app_dir.into(),
            host: host.into(),
            port,
            denial: Arc::new(Mutex::new(None)),
        }
    }

    fn denial_handle(&self) -> Arc<Mutex<Option<HostKeyDenial>>> {
        Arc::clone(&self.denial)
    }

    fn record(&self, denial: HostKeyDenial) {
        if let Ok(mut slot) = self.denial.lock() {
            *slot = Some(denial);
        }
    }

    /// Reason the last handshake was rejected, if any.
    pub fn denial(&self) -> Option<HostKeyDenial> {
        self.denial.lock().ok().and_then(|slot| slot.clone())
    }
}

#[async_trait]
impl Handler for StrictHostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_type = server_public_key.name().to_string();
        let fingerprint = server_public_key.fingerprint();

        let known_hosts = match store::load_known_hosts(&self.app_dir) {
            Ok(hosts) => hosts,
            Err(error) => {
                self.record(HostKeyDenial {
                    host: self.host.clone(),
                    port: self.port,
                    key_type,
                    fingerprint,
                    stored_fingerprint: Some(error),
                });
                return Ok(false);
            }
        };

        let Some(known) = find_known_host(&known_hosts, &self.host, self.port) else {
            self.record(HostKeyDenial {
                host: self.host.clone(),
                port: self.port,
                key_type,
                fingerprint,
                stored_fingerprint: None,
            });
            return Ok(false);
        };

        if known.fingerprint == fingerprint && known.key_type == key_type {
            return Ok(true);
        }

        self.record(HostKeyDenial {
            host: self.host.clone(),
            port: self.port,
            key_type,
            fingerprint,
            stored_fingerprint: Some(known.fingerprint.clone()),
        });
        Ok(false)
    }
}

pub fn find_known_host<'a>(
    known_hosts: &'a [KnownHost],
    host: &str,
    port: u16,
) -> Option<&'a KnownHost> {
    known_hosts
        .iter()
        .find(|entry| entry.host == host && entry.port == port)
}

/// Convert a failed connect into the most specific message available.
///
/// When the handler recorded a host-key denial, that reason beats the raw
/// russh error (`UnknownKey`), which tells the user nothing actionable.
pub fn describe_connect_failure(denial: Option<HostKeyDenial>, fallback: String) -> String {
    match denial {
        Some(denial) => denial.message(),
        None => fallback,
    }
}

/// Build the mismatch payload the desktop UI expects.
pub fn mismatch_payload(denial: &HostKeyDenial) -> HostKeyMismatch {
    HostKeyMismatch {
        host: denial.host.clone(),
        port: denial.port,
        key_type: denial.key_type.clone(),
        fingerprint: denial.fingerprint.clone(),
        stored_fingerprint: denial.stored_fingerprint.clone().unwrap_or_default(),
    }
}

/// Convenience wrapper: connect to a saved server with fail-closed host keys.
pub async fn connect_saved_server(
    app_dir: &Path,
    host: &str,
    port: u16,
    user: &str,
    auth: &AuthMethod,
    timeout_seconds: Option<u64>,
) -> Result<Handle<StrictHostKeyHandler>, String> {
    let handler = StrictHostKeyHandler::new(app_dir.to_path_buf(), host, port);
    let denial_handle = handler.denial_handle();
    let result = connect(handler, host, port, user, auth, timeout_seconds).await;
    match result {
        Ok(session) => Ok(session),
        Err(error) => {
            let denial = denial_handle.lock().ok().and_then(|slot| slot.clone());
            Err(describe_connect_failure(denial, error))
        }
    }
}

// ------------------------------------------------------- command execution

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutcome {
    pub output: String,
    pub exit_code: Option<u32>,
    pub truncated: bool,
}

/// Append a chunk, stopping once the output cap is reached.
///
/// Returns true when this call is what crossed the cap. After truncation the
/// marker is appended once and further chunks are discarded.
pub fn append_capped(target: &mut String, chunk: &str) -> bool {
    if target.len() >= MAX_OUTPUT_BYTES {
        return false;
    }

    let remaining = MAX_OUTPUT_BYTES - target.len();
    if chunk.len() <= remaining {
        target.push_str(chunk);
        return false;
    }

    let mut end = remaining;
    while !chunk.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&chunk[..end]);
    target.push_str(TRUNCATION_MARKER);
    true
}

async fn collect_command_output(
    channel: &mut russh::Channel<russh::client::Msg>,
) -> Result<CommandOutcome, String> {
    let mut output = String::new();
    let mut exit_code = None;
    let mut truncated = false;

    loop {
        let Some(message) = channel.wait().await else {
            break;
        };

        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                let text = String::from_utf8_lossy(data.as_ref());
                if append_capped(&mut output, &text) {
                    truncated = true;
                }
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status);
            }
            ChannelMsg::ExitSignal {
                signal_name,
                error_message,
                ..
            } => {
                return Err(format!(
                    "Command terminated by signal {:?}: {}",
                    signal_name, error_message
                ));
            }
            ChannelMsg::Failure => {
                return Err("Remote command request failed".to_string());
            }
            ChannelMsg::Close | ChannelMsg::Eof => {
                // Keep reading — ExitStatus may arrive after close/eof.
                // The loop breaks when channel.wait() returns None.
            }
            _ => {}
        }
    }

    if truncated && !output.ends_with(TRUNCATION_MARKER) {
        output.push_str(TRUNCATION_MARKER);
    }

    Ok(CommandOutcome {
        output,
        exit_code,
        truncated,
    })
}

/// Run one command and capture bounded stdout/stderr plus the exit status.
///
/// `pty` allocates a pseudo-terminal. The desktop wants one (so interactive
/// prompts and pagers behave); the CLI does not, because there is no stdin to
/// answer a prompt with and a plain exec gives cleaner, parseable output.
pub async fn exec_command<H: Handler>(
    session: &Handle<H>,
    command: &str,
    pty: Option<(u32, u32)>,
    timeout_seconds: Option<u64>,
) -> Result<CommandOutcome, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open session channel: {}", e))?;

    if let Some((width, height)) = pty {
        if channel
            .request_pty(false, "xterm-256color", width, height, 0, 0, &[])
            .await
            .is_err()
        {
            tracing::debug!("PTY allocation failed, falling back to plain exec");
        }
    }

    channel
        .exec(true, command.as_bytes().to_vec())
        .await
        .map_err(|e| format!("Failed to start command: {}", e))?;

    match timeout_seconds {
        Some(seconds) => {
            let limited = Duration::from_secs(clamp_timeout(seconds));
            timeout(limited, collect_command_output(&mut channel))
                .await
                .map_err(|_| format!("Command timed out after {} seconds", limited.as_secs()))?
        }
        None => collect_command_output(&mut channel).await,
    }
}

/// Clamp a requested command timeout into the supported window.
///
/// The lower bound matches the desktop Actions form (`min="5"`), so the app and
/// the CLI agree on what a usable timeout is. This is the one clamp both
/// `exec_command` and the CLI apply; there is no second copy to drift.
pub fn clamp_timeout(requested: u64) -> u64 {
    requested.clamp(MIN_COMMAND_TIMEOUT_SECONDS, MAX_COMMAND_TIMEOUT_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AuthMethod, SecretKind};

    #[test]
    fn append_capped_truncates_once_and_marks() {
        let mut output = String::new();
        assert!(!append_capped(&mut output, &"a".repeat(16)));
        assert!(append_capped(&mut output, &"b".repeat(MAX_OUTPUT_BYTES)));
        assert!(output.ends_with(TRUNCATION_MARKER));
        assert!(output.len() <= MAX_OUTPUT_BYTES + TRUNCATION_MARKER.len());
        // Further chunks are dropped, and the marker is not repeated.
        assert!(!append_capped(&mut output, "more"));
        assert_eq!(output.matches(TRUNCATION_MARKER).count(), 1);
    }

    #[test]
    fn append_capped_respects_char_boundaries() {
        let mut output = "x".repeat(MAX_OUTPUT_BYTES - 1);
        assert!(append_capped(&mut output, "é"));
        assert!(output.is_char_boundary(output.len()));
    }

    #[test]
    fn unknown_host_denial_is_not_a_mismatch() {
        let denial = HostKeyDenial {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:abc".to_string(),
            stored_fingerprint: None,
        };
        assert!(!denial.is_mismatch());
        assert!(denial.message().contains("Unknown host key"));
        assert!(denial.message().contains("SSH THING"));
    }

    #[test]
    fn mismatch_denial_is_flagged() {
        let denial = HostKeyDenial {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:new".to_string(),
            stored_fingerprint: Some("SHA256:old".to_string()),
        };
        assert!(denial.is_mismatch());
        assert!(denial.message().contains("Host key mismatch"));
        assert_eq!(mismatch_payload(&denial).stored_fingerprint, "SHA256:old");
    }

    #[test]
    fn describe_prefers_denial_over_raw_error() {
        let denial = HostKeyDenial {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:abc".to_string(),
            stored_fingerprint: None,
        };
        let message =
            describe_connect_failure(Some(denial), "Failed to connect: UnknownKey".into());
        assert!(message.contains("Unknown host key"));
    }

    #[test]
    fn find_known_host_matches_host_and_port() {
        let hosts = vec![KnownHost {
            host: "example.com".to_string(),
            port: 2222,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:abc".to_string(),
            public_key_base64: "AAA".to_string(),
            added_at: 1,
        }];
        assert!(find_known_host(&hosts, "example.com", 2222).is_some());
        assert!(find_known_host(&hosts, "example.com", 22).is_none());
    }

    #[test]
    fn clamp_timeout_keeps_requested_within_bounds() {
        assert_eq!(clamp_timeout(0), MIN_COMMAND_TIMEOUT_SECONDS);
        assert_eq!(clamp_timeout(1), MIN_COMMAND_TIMEOUT_SECONDS);
        assert_eq!(clamp_timeout(60), 60);
        assert_eq!(clamp_timeout(10_000), MAX_COMMAND_TIMEOUT_SECONDS);
    }

    #[test]
    fn auth_shapes_survive_round_trip() {
        let auth = AuthMethod::SecretRef {
            secret_id: "server:1:password".to_string(),
            kind: SecretKind::Password,
        };
        let json = serde_json::to_string(&auth).expect("serialize");
        let parsed: AuthMethod = serde_json::from_str(&json).expect("deserialize");
        match parsed {
            AuthMethod::SecretRef { secret_id, kind } => {
                assert_eq!(secret_id, "server:1:password");
                assert_eq!(kind, SecretKind::Password);
            }
            _ => panic!("wrong auth variant"),
        }
    }
}

//! File upload commands.
//!
//! Picking and transferring are separate commands so the confirmation dialog
//! can show file sizes before anything touches the network. Both talk to the
//! shared [`ssh_thing_core::sftp`] engine; this module only owns the Tauri
//! concerns: the native picker, the session registry, and progress events.

use std::path::PathBuf;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use ssh_thing_core::model::{
    TransferProgressEvent, UploadCandidate, UploadResult, UploadStatus, SFTP_IO_TIMEOUT_SECONDS,
    SFTP_SUBSYSTEM_ACK_TIMEOUT_SECONDS,
};
use ssh_thing_core::sftp::{self, UploadOutcome};

use crate::AppState;

/// Arguments for one upload batch.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRequest {
    pub connection_id: String,
    pub local_paths: Vec<String>,
    /// What the user typed. `~` is expanded server-side against the login
    /// directory, so the UI never has to know it.
    pub remote_dir: String,
    #[serde(default)]
    pub overwrite: bool,
}

/// Open the native multi-select picker and describe what was chosen.
///
/// Cancelling is not an error: the frontend treats an empty list as a no-op, so
/// dismissing the dialog does not raise a failure toast.
#[tauri::command]
pub async fn pick_upload_files(app: AppHandle) -> Result<Vec<UploadCandidate>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_title("Select files to upload")
        .pick_files(move |picked| {
            let _ = tx.send(picked);
        });

    let picked = rx
        .await
        .map_err(|_| "The file dialog closed unexpectedly.".to_string())?;

    let Some(paths) = picked else {
        return Ok(Vec::new());
    };

    let mut candidates = Vec::with_capacity(paths.len());
    for file_path in paths {
        let path: PathBuf = file_path
            .into_path()
            .map_err(|e| format!("Unsupported file selection: {}", e))?;

        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());

        // A directory picked here keeps its reported size of 0 and is rejected
        // by `upload_files` with a clear message, so the failure is visible
        // rather than silent.
        let size = tokio::fs::metadata(&path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);

        candidates.push(UploadCandidate {
            path: path.to_string_lossy().into_owned(),
            name,
            size,
        });
    }

    Ok(candidates)
}

/// Upload local files to a directory on the server behind `connectionId`.
///
/// Per-file failures are returned inside the result vector so one bad file
/// never aborts the batch. Only a problem with the session itself (missing
/// connection, no SFTP subsystem, unusable destination) fails the whole call.
#[tauri::command]
pub async fn upload_files(
    app: AppHandle,
    request: UploadRequest,
) -> Result<Vec<UploadResult>, String> {
    if request.local_paths.is_empty() {
        return Ok(Vec::new());
    }

    // Hold the registry lock only for the channel handshake. Everything below
    // moves bytes, and `send_input`/`resize` must stay responsive throughout.
    let (client, home) = {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().await;
        let managed = sessions
            .get(&request.connection_id)
            .ok_or_else(|| format!("Session {} not found", request.connection_id))?;

        let client = sftp::open_sftp(
            &managed.handle,
            SFTP_SUBSYSTEM_ACK_TIMEOUT_SECONDS,
            SFTP_IO_TIMEOUT_SECONDS,
        )
        .await?;

        // "." resolves to the login directory; fall back to it literally if the
        // server will not answer, since the relative path still resolves.
        let home = client
            .canonicalize(".")
            .await
            .unwrap_or_else(|_| ".".to_string());

        (client, home)
    };

    let destination = sftp::normalize_remote_dir(&request.remote_dir, &home)?;

    let batch = BatchContext {
        connection_id: request.connection_id.clone(),
        destination,
        overwrite: request.overwrite,
        total_files: request.local_paths.len(),
    };

    let mut results = Vec::with_capacity(batch.total_files);

    for (index, local_path) in request.local_paths.iter().enumerate() {
        results.push(upload_one(&app, &client, &batch, index, local_path).await);
    }

    Ok(results)
}

/// Loop-invariant details for one batch.
struct BatchContext {
    connection_id: String,
    destination: String,
    overwrite: bool,
    total_files: usize,
}

/// Transfer a single file and turn every failure into a per-file result.
async fn upload_one(
    app: &AppHandle,
    client: &sftp::SftpSession,
    batch: &BatchContext,
    index: usize,
    local_path: &str,
) -> UploadResult {
    let path = PathBuf::from(local_path);
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| local_path.to_string());
    let remote_path = sftp::join_remote(&batch.destination, &name);

    let failed = |error: String| UploadResult {
        name: name.clone(),
        remote_path: remote_path.clone(),
        bytes_sent: 0,
        status: UploadStatus::Failed,
        error: Some(error),
    };

    let metadata = match tokio::fs::metadata(&path).await {
        Ok(meta) => meta,
        Err(error) => return failed(format!("Cannot read {}: {}", path.display(), error)),
    };

    if metadata.is_dir() {
        return failed("Folders cannot be uploaded yet.".to_string());
    }

    if let Err(error) = sftp::check_upload_size(metadata.len()) {
        return failed(error);
    }

    let total_bytes = metadata.len();
    let emit_progress = |bytes_sent: u64, done: bool| {
        let _ = app.emit(
            "transfer-progress",
            TransferProgressEvent {
                connection_id: batch.connection_id.clone(),
                index,
                total_files: batch.total_files,
                name: name.clone(),
                bytes_sent,
                total_bytes,
                done,
            },
        );
    };

    let outcome = sftp::upload_file(client, &path, &remote_path, batch.overwrite, |bytes_sent| {
        emit_progress(bytes_sent, false)
    })
    .await;

    match outcome {
        Ok(UploadOutcome::Uploaded { bytes_sent }) => {
            emit_progress(bytes_sent, true);
            UploadResult {
                name,
                remote_path,
                bytes_sent,
                status: UploadStatus::Uploaded,
                error: None,
            }
        }
        Ok(UploadOutcome::SkippedExists) => UploadResult {
            name,
            remote_path,
            bytes_sent: 0,
            status: UploadStatus::SkippedExists,
            error: Some("A file with this name already exists.".to_string()),
        },
        Err(error) => failed(error),
    }
}

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::time::{timeout, Duration};
use tracing::debug;

use crate::{
    connect_ssh, disconnect_ssh, get_app_dir, load_servers, parse_json_array_lenient,
    ServerConnection,
};

const ACTIONS_FILE: &str = "actions.json";
const ACTION_HISTORY_FILE: &str = "action-history.json";
const MAX_HISTORY_ENTRIES: usize = 250;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub server_id: String,
    pub command: String,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub last_executed_at: Option<u64>,
    #[serde(default)]
    pub last_execution_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionHistoryEntry {
    pub id: String,
    pub action_id: String,
    pub action_name: String,
    pub server_id: String,
    pub server_label: String,
    pub command: String,
    pub started_at: u64,
    pub completed_at: u64,
    pub status: String,
    #[serde(default)]
    pub exit_code: Option<u32>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionExecutionEvent {
    pub action_id: String,
    pub action_name: String,
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub entry: Option<ActionHistoryEntry>,
}

#[derive(Debug)]
struct ActionCommandOutcome {
    output: String,
    exit_code: Option<u32>,
}

fn unix_timestamp_now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))
        .map(|duration| duration.as_secs())
}

fn get_actions_path(app_dir: &Path) -> PathBuf {
    app_dir.join(ACTIONS_FILE)
}

fn get_action_history_path(app_dir: &Path) -> PathBuf {
    app_dir.join(ACTION_HISTORY_FILE)
}

fn load_actions(app_dir: &Path) -> Result<Vec<Action>, String> {
    let path = get_actions_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let data =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read actions file: {}", e))?;
    parse_json_array_lenient(&data, "actions")
}

fn save_actions(app_dir: &Path, actions: &[Action]) -> Result<(), String> {
    let path = get_actions_path(app_dir);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path for actions file".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(actions)
        .map_err(|e| format!("Failed to serialize actions: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write actions file: {}", e))?;
    Ok(())
}

fn load_action_history(app_dir: &Path) -> Result<Vec<ActionHistoryEntry>, String> {
    let path = get_action_history_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read action history file: {}", e))?;
    parse_json_array_lenient(&data, "action history")
}

fn save_action_history(app_dir: &Path, entries: &[ActionHistoryEntry]) -> Result<(), String> {
    let path = get_action_history_path(app_dir);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path for action history file".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Failed to serialize action history: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write action history file: {}", e))?;
    Ok(())
}

fn append_history_entry(app_dir: &Path, entry: ActionHistoryEntry) -> Result<(), String> {
    let mut entries = load_action_history(app_dir)?;
    entries.push(entry);
    if entries.len() > MAX_HISTORY_ENTRIES {
        let drain_count = entries.len() - MAX_HISTORY_ENTRIES;
        entries.drain(0..drain_count);
    }
    save_action_history(app_dir, &entries)
}

fn emit_action_event(
    app: &AppHandle,
    action_id: &str,
    action_name: &str,
    status: &str,
    message: impl Into<String>,
    entry: Option<ActionHistoryEntry>,
) {
    let payload = ActionExecutionEvent {
        action_id: action_id.to_string(),
        action_name: action_name.to_string(),
        status: status.to_string(),
        message: message.into(),
        entry,
    };

    let _ = app.emit("action-execution", payload);
}

fn update_action_execution_state(
    actions: &mut [Action],
    action_id: &str,
    completed_at: u64,
    status: &str,
) {
    if let Some(action) = actions.iter_mut().find(|item| item.id == action_id) {
        action.last_executed_at = Some(completed_at);
        action.last_execution_status = Some(status.to_string());
    }
}

fn server_label(server: &ServerConnection) -> String {
    match &server.nickname {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => format!("{}@{}:{}", server.user, server.host, server.port),
    }
}

fn push_output(target: &mut String, chunk: &str) {
    if target.len() >= MAX_OUTPUT_BYTES {
        return;
    }

    let remaining = MAX_OUTPUT_BYTES - target.len();
    if chunk.len() <= remaining {
        target.push_str(chunk);
        return;
    }

    let mut end = remaining;
    while !chunk.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&chunk[..end]);
    target.push_str("\n[output truncated]");
}

async fn collect_command_output(
    channel: &mut russh::Channel<russh::client::Msg>,
) -> Result<ActionCommandOutcome, String> {
    let mut output = String::new();
    let mut exit_code = None;

    loop {
        let Some(message) = channel.wait().await else {
            break;
        };

        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                let text = String::from_utf8_lossy(data.as_ref());
                push_output(&mut output, &text);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status);
                break;
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
                break;
            }
            _ => {}
        }
    }

    Ok(ActionCommandOutcome { output, exit_code })
}

async fn run_action_command(
    app: &AppHandle,
    action: &Action,
    server: &ServerConnection,
) -> Result<ActionCommandOutcome, String> {
    let session = connect_ssh(
        app,
        &server.host,
        server.port,
        &server.user,
        &server.auth,
        server.timeout_seconds,
        None,
        None,
    )
    .await?;

    let action_result = async {
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("Failed to open session channel: {}", e))?;

        channel
            .exec(true, action.command.clone())
            .await
            .map_err(|e| format!("Failed to start command: {}", e))?;

        emit_action_event(
            app,
            &action.id,
            &action.name,
            "running",
            format!("Running on {}", server_label(server)),
            None,
        );

        if let Some(timeout_seconds) = action.timeout_seconds {
            let command_timeout = Duration::from_secs(timeout_seconds.max(1));
            timeout(command_timeout, collect_command_output(&mut channel))
                .await
                .map_err(|_| {
                    format!(
                        "Command timed out after {} seconds",
                        command_timeout.as_secs()
                    )
                })?
        } else {
            collect_command_output(&mut channel).await
        }
    }
    .await;

    let _ = disconnect_ssh(app, Some(session), None, None).await;
    action_result
}

#[tauri::command]
pub async fn get_actions(app: AppHandle) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    load_actions(&app_dir)
}

#[tauri::command]
pub async fn add_action(app: AppHandle, action: Action) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = load_actions(&app_dir)?;
    actions.push(action);
    save_actions(&app_dir, &actions)?;
    Ok(actions)
}

#[tauri::command]
pub async fn update_action(
    app: AppHandle,
    id: String,
    action: Action,
) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = load_actions(&app_dir)?;
    let index = actions
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| format!("Action with id {} not found", id))?;
    actions[index] = action;
    save_actions(&app_dir, &actions)?;
    Ok(actions)
}

#[tauri::command]
pub async fn delete_action(app: AppHandle, id: String) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = load_actions(&app_dir)?;
    let index = actions
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| format!("Action with id {} not found", id))?;
    actions.remove(index);
    save_actions(&app_dir, &actions)?;

    let history = load_action_history(&app_dir)?;
    let filtered: Vec<ActionHistoryEntry> = history
        .into_iter()
        .filter(|entry| entry.action_id != id)
        .collect();
    save_action_history(&app_dir, &filtered)?;

    Ok(actions)
}

#[tauri::command]
pub async fn get_action_history(
    app: AppHandle,
    action_id: Option<String>,
) -> Result<Vec<ActionHistoryEntry>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut history = load_action_history(&app_dir)?;
    history.sort_by(|left, right| right.completed_at.cmp(&left.completed_at));

    if let Some(target_id) = action_id {
        history.retain(|entry| entry.action_id == target_id);
    }

    Ok(history)
}

#[tauri::command]
pub async fn execute_action(
    app: AppHandle,
    action_id: String,
) -> Result<ActionHistoryEntry, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = load_actions(&app_dir)?;
    let action = actions
        .iter()
        .find(|item| item.id == action_id)
        .cloned()
        .ok_or_else(|| format!("Action with id {} not found", action_id))?;
    let servers = load_servers(&app_dir, &app)?;
    let server = servers
        .iter()
        .find(|item| item.id == action.server_id)
        .cloned()
        .ok_or_else(|| {
            format!(
                "Server with id {} not found for action {}",
                action.server_id, action.name
            )
        })?;
    let started_at = unix_timestamp_now()?;

    emit_action_event(
        &app,
        &action.id,
        &action.name,
        "connecting",
        format!("Connecting to {}", server_label(&server)),
        None,
    );

    debug!(action_id = %action.id, server_id = %server.id, "Executing action");

    match run_action_command(&app, &action, &server).await {
        Ok(outcome) => {
            let completed_at = unix_timestamp_now()?;
            let status = if outcome.exit_code.unwrap_or(0) == 0 {
                "success"
            } else {
                "error"
            };
            let error = if status == "error" {
                Some(match outcome.exit_code {
                    Some(code) => format!("Command exited with status {}", code),
                    None => "Command failed without an exit status".to_string(),
                })
            } else {
                None
            };
            let entry = ActionHistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                action_id: action.id.clone(),
                action_name: action.name.clone(),
                server_id: server.id.clone(),
                server_label: server_label(&server),
                command: action.command.clone(),
                started_at,
                completed_at,
                status: status.to_string(),
                exit_code: outcome.exit_code,
                output: if outcome.output.is_empty() {
                    None
                } else {
                    Some(outcome.output)
                },
                error,
            };

            update_action_execution_state(&mut actions, &action.id, completed_at, status);
            save_actions(&app_dir, &actions)?;
            append_history_entry(&app_dir, entry.clone())?;

            emit_action_event(
                &app,
                &action.id,
                &action.name,
                status,
                if status == "success" {
                    format!("{} completed", action.name)
                } else {
                    format!("{} finished with errors", action.name)
                },
                Some(entry.clone()),
            );

            if status == "success" {
                Ok(entry)
            } else {
                Err(entry
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("{} failed", action.name)))
            }
        }
        Err(error_message) => {
            let completed_at = unix_timestamp_now()?;
            let entry = ActionHistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                action_id: action.id.clone(),
                action_name: action.name.clone(),
                server_id: server.id.clone(),
                server_label: server_label(&server),
                command: action.command.clone(),
                started_at,
                completed_at,
                status: "error".to_string(),
                exit_code: None,
                output: None,
                error: Some(error_message.clone()),
            };

            update_action_execution_state(&mut actions, &action.id, completed_at, "error");
            save_actions(&app_dir, &actions)?;
            append_history_entry(&app_dir, entry.clone())?;

            emit_action_event(
                &app,
                &action.id,
                &action.name,
                "error",
                error_message.clone(),
                Some(entry),
            );

            Err(error_message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_action_serialization() {
        let action = Action {
            id: "action-1".to_string(),
            name: "Restart API".to_string(),
            description: Some("Restarts the service".to_string()),
            server_id: "server-1".to_string(),
            command: "sudo systemctl restart api".to_string(),
            timeout_seconds: Some(30),
            last_executed_at: Some(1_700_000_000),
            last_execution_status: Some("success".to_string()),
        };

        let json = serde_json::to_string(&action).expect("Failed to serialize action");
        let deserialized: Action =
            serde_json::from_str(&json).expect("Failed to deserialize action");

        assert_eq!(action.id, deserialized.id);
        assert_eq!(action.command, deserialized.command);
        assert_eq!(
            action.last_execution_status,
            deserialized.last_execution_status
        );
    }

    #[test]
    fn test_action_history_serialization() {
        let entry = ActionHistoryEntry {
            id: "history-1".to_string(),
            action_id: "action-1".to_string(),
            action_name: "Restart API".to_string(),
            server_id: "server-1".to_string(),
            server_label: "prod-api".to_string(),
            command: "sudo systemctl restart api".to_string(),
            started_at: 1_700_000_000,
            completed_at: 1_700_000_010,
            status: "success".to_string(),
            exit_code: Some(0),
            output: Some("done".to_string()),
            error: None,
        };

        let json = serde_json::to_string(&entry).expect("Failed to serialize history entry");
        let deserialized: ActionHistoryEntry =
            serde_json::from_str(&json).expect("Failed to deserialize history entry");

        assert_eq!(entry.action_id, deserialized.action_id);
        assert_eq!(entry.exit_code, deserialized.exit_code);
        assert_eq!(entry.output, deserialized.output);
    }

    #[test]
    fn test_push_output_truncates_long_text() {
        let mut output = String::new();
        push_output(&mut output, &"a".repeat(MAX_OUTPUT_BYTES + 128));
        assert!(output.len() <= MAX_OUTPUT_BYTES + 32);
        assert!(output.contains("[output truncated]"));
    }
}

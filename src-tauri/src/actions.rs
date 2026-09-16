use tauri::{AppHandle, Emitter};
use tracing::debug;

use crate::ServerConnection;
use crate::{connect_ssh, get_app_dir, Action, ActionExecutionEvent, ActionHistoryEntry};
use ssh_thing_core::store as core_store;
use ssh_thing_core::CommandOutcome;

#[tauri::command]
pub async fn get_actions(app: AppHandle) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    core_store::load_actions(&app_dir)
}

#[tauri::command]
pub async fn add_action(app: AppHandle, action: Action) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = core_store::load_actions(&app_dir)?;
    actions.push(action);
    core_store::save_actions(&app_dir, &actions)?;
    Ok(actions)
}

#[tauri::command]
pub async fn update_action(
    app: AppHandle,
    id: String,
    action: Action,
) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = core_store::load_actions(&app_dir)?;
    let index = actions
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| format!("Action with id {} not found", id))?;
    actions[index] = action;
    core_store::save_actions(&app_dir, &actions)?;
    Ok(actions)
}

#[tauri::command]
pub async fn delete_action(app: AppHandle, id: String) -> Result<Vec<Action>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut actions = core_store::load_actions(&app_dir)?;
    let index = actions
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| format!("Action with id {} not found", id))?;
    actions.remove(index);
    core_store::save_actions(&app_dir, &actions)?;

    let history = core_store::load_action_history(&app_dir)?;
    let filtered: Vec<ActionHistoryEntry> = history
        .into_iter()
        .filter(|entry| entry.action_id != id)
        .collect();
    core_store::save_action_history(&app_dir, &filtered)?;

    Ok(actions)
}

#[tauri::command]
pub async fn get_action_history(
    app: AppHandle,
    action_id: Option<String>,
) -> Result<Vec<ActionHistoryEntry>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut history = core_store::load_action_history(&app_dir)?;
    history.sort_by_key(|entry| std::cmp::Reverse(entry.completed_at));

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
    let mut actions = core_store::load_actions(&app_dir)?;
    let action = actions
        .iter()
        .find(|item| item.id == action_id)
        .cloned()
        .ok_or_else(|| format!("Action with id {} not found", action_id))?;
    let servers = core_store::load_servers_migrated(&app_dir)?;
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
    let started_at = core_store::unix_timestamp_now()?;

    emit_action_event(
        &app,
        &action.id,
        &action.name,
        "connecting",
        format!("Connecting to {}", server.label()),
        None,
    );

    debug!(action_id = %action.id, server_id = %server.id, "Executing action");

    match run_action_command(&app, &action, &server).await {
        Ok(outcome) => {
            let completed_at = core_store::unix_timestamp_now()?;
            let (status, error) = match outcome.exit_code {
                Some(0) => ("success", None),
                Some(code) => (
                    "error",
                    Some(format!("Command exited with status {}", code)),
                ),
                None => {
                    if outcome.output.is_empty() {
                        ("error", Some("Command produced no output and returned no exit status — the command may have failed to start or the SSH server closed the channel abnormally.".to_string()))
                    } else {
                        (
                            "error",
                            Some("Command completed without an exit status".to_string()),
                        )
                    }
                }
            };
            let entry = ActionHistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                action_id: action.id.clone(),
                action_name: action.name.clone(),
                server_id: server.id.clone(),
                server_label: server.label(),
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
            core_store::save_actions(&app_dir, &actions)?;
            core_store::append_history_entry(&app_dir, entry.clone())?;

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
            let completed_at = core_store::unix_timestamp_now()?;
            let entry = ActionHistoryEntry {
                id: uuid::Uuid::new_v4().to_string(),
                action_id: action.id.clone(),
                action_name: action.name.clone(),
                server_id: server.id.clone(),
                server_label: server.label(),
                command: action.command.clone(),
                started_at,
                completed_at,
                status: "error".to_string(),
                exit_code: None,
                output: None,
                error: Some(error_message.clone()),
            };

            update_action_execution_state(&mut actions, &action.id, completed_at, "error");
            core_store::save_actions(&app_dir, &actions)?;
            core_store::append_history_entry(&app_dir, entry.clone())?;

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

/// Run an action's stored command over a one-shot SSH session.
///
/// Allocates a PTY, matching the desktop behaviour, so commands that expect a
/// terminal behave the same as before. Output capture, the 64 KiB cap, and the
/// timeout come from `ssh-thing-core` and are shared with the CLI.
async fn run_action_command(
    app: &AppHandle,
    action: &Action,
    server: &ServerConnection,
) -> Result<CommandOutcome, String> {
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

    emit_action_event(
        app,
        &action.id,
        &action.name,
        "running",
        format!("Running on {}", server.label()),
        None,
    );

    let result = ssh_thing_core::exec_command(
        &session,
        &action.command,
        Some((80, 24)),
        action.timeout_seconds,
    )
    .await;

    ssh_thing_core::disconnect_quiet(session).await;
    result
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
    fn execution_state_updates_only_the_target_action() {
        let mut actions = vec![
            Action {
                id: "a1".to_string(),
                name: "One".to_string(),
                description: None,
                server_id: "s1".to_string(),
                command: "true".to_string(),
                timeout_seconds: None,
                last_executed_at: None,
                last_execution_status: None,
            },
            Action {
                id: "a2".to_string(),
                name: "Two".to_string(),
                description: None,
                server_id: "s1".to_string(),
                command: "true".to_string(),
                timeout_seconds: None,
                last_executed_at: None,
                last_execution_status: None,
            },
        ];

        update_action_execution_state(&mut actions, "a2", 42, "success");

        assert!(actions[0].last_executed_at.is_none());
        assert_eq!(actions[1].last_executed_at, Some(42));
        assert_eq!(actions[1].last_execution_status.as_deref(), Some("success"));
    }
}

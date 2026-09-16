//! JSON stores under the app-data directory.
//!
//! Every loader is lenient in the same way the desktop app already was:
//! unknown fields are ignored, missing optional fields default, and
//! individually malformed records are skipped rather than failing the whole
//! file. The CLI must tolerate files written by newer or older app versions.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::model::{
    Action, ActionHistoryEntry, AuthMethod, CliHistoryEntry, KnownHost, SecretKind,
    ServerConnection, Snippet, ACTIONS_FILE, ACTION_HISTORY_FILE, CLI_HISTORY_FILE,
    KNOWN_HOSTS_FILE, MAX_CLI_HISTORY_ENTRIES, MAX_HISTORY_ENTRIES, SERVERS_FILE, SETTINGS_FILE,
    SNIPPETS_FILE,
};
use crate::secrets;

pub fn unix_timestamp_now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))
        .map(|duration| duration.as_secs())
}

fn path_in(app_dir: &Path, file: &str) -> PathBuf {
    app_dir.join(file)
}

/// Parse a JSON array, skipping individual records that fail to deserialize.
///
/// Only reports an error when the file cannot be parsed at all, or when every
/// record was rejected — which in practice means the file is the wrong shape.
pub fn parse_json_array_lenient<T>(data: &str, label: &str) -> Result<Vec<T>, String>
where
    T: DeserializeOwned,
{
    match serde_json::from_str::<Vec<T>>(data) {
        Ok(items) => Ok(items),
        Err(primary_error) => {
            let raw_items: Vec<serde_json::Value> = serde_json::from_str(data)
                .map_err(|e| format!("Failed to parse {} file: {}", label, e))?;
            let mut parsed = Vec::new();
            let mut skipped = 0usize;
            for item in raw_items {
                match serde_json::from_value::<T>(item) {
                    Ok(entry) => parsed.push(entry),
                    Err(_) => skipped += 1,
                }
            }
            if parsed.is_empty() {
                Err(format!("Failed to parse {} file: {}", label, primary_error))
            } else {
                if skipped > 0 {
                    tracing::debug!(
                        label,
                        skipped,
                        "Skipped malformed records while loading data"
                    );
                }
                Ok(parsed)
            }
        }
    }
}

fn read_array<T>(app_dir: &Path, file: &str, label: &str) -> Result<Vec<T>, String>
where
    T: DeserializeOwned,
{
    let path = path_in(app_dir, file);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {} file: {}", label, e))?;
    parse_json_array_lenient(&data, label)
}

fn write_array<T>(app_dir: &Path, file: &str, label: &str, items: &[T]) -> Result<(), String>
where
    T: Serialize,
{
    let path = path_in(app_dir, file);
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path for {} file", label))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(items)
        .map_err(|e| format!("Failed to serialize {}: {}", label, e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write {} file: {}", label, e))?;
    Ok(())
}

// ---------------------------------------------------------------- servers

pub fn get_servers_path(app_dir: &Path) -> PathBuf {
    path_in(app_dir, SERVERS_FILE)
}

pub fn load_servers(app_dir: &Path) -> Result<Vec<ServerConnection>, String> {
    read_array(app_dir, SERVERS_FILE, "servers")
}

pub fn save_servers(app_dir: &Path, servers: &[ServerConnection]) -> Result<(), String> {
    write_array(app_dir, SERVERS_FILE, "servers", servers)
}

/// Move a legacy inline password/private key into the OS keyring.
pub fn migrate_server_auth(server: &mut ServerConnection) -> Result<(), String> {
    match &server.auth {
        AuthMethod::SecretRef { .. } => Ok(()),
        AuthMethod::Password { password } => {
            let secret_id = format!("server:{}:password", server.id);
            secrets::put_secret(&secret_id, password)?;
            server.auth = AuthMethod::SecretRef {
                secret_id,
                kind: SecretKind::Password,
            };
            Ok(())
        }
        AuthMethod::Key { private_key } => {
            let secret_id = format!("server:{}:private_key", server.id);
            secrets::put_secret(&secret_id, private_key)?;
            server.auth = AuthMethod::SecretRef {
                secret_id,
                kind: SecretKind::PrivateKey,
            };
            Ok(())
        }
    }
}

/// Load servers and migrate any leftover plaintext credentials into the
/// keyring, persisting the file when something changed.
pub fn load_servers_migrated(app_dir: &Path) -> Result<Vec<ServerConnection>, String> {
    let mut servers = load_servers(app_dir)?;

    let mut changed = false;
    for server in servers.iter_mut() {
        if matches!(server.auth, AuthMethod::SecretRef { .. }) {
            continue;
        }
        migrate_server_auth(server)?;
        changed = true;
    }

    if changed {
        save_servers(app_dir, &servers)?;
    }

    Ok(servers)
}

// --------------------------------------------------------------- snippets

pub fn get_snippets_path(app_dir: &Path) -> PathBuf {
    path_in(app_dir, SNIPPETS_FILE)
}

pub fn load_snippets(app_dir: &Path) -> Result<Vec<Snippet>, String> {
    read_array(app_dir, SNIPPETS_FILE, "snippets")
}

pub fn save_snippets(app_dir: &Path, snippets: &[Snippet]) -> Result<(), String> {
    write_array(app_dir, SNIPPETS_FILE, "snippets", snippets)
}

// ---------------------------------------------------------------- actions

pub fn get_actions_path(app_dir: &Path) -> PathBuf {
    path_in(app_dir, ACTIONS_FILE)
}

pub fn load_actions(app_dir: &Path) -> Result<Vec<Action>, String> {
    read_array(app_dir, ACTIONS_FILE, "actions")
}

pub fn save_actions(app_dir: &Path, actions: &[Action]) -> Result<(), String> {
    write_array(app_dir, ACTIONS_FILE, "actions", actions)
}

// ----------------------------------------------------------- known hosts

pub fn get_known_hosts_path(app_dir: &Path) -> PathBuf {
    path_in(app_dir, KNOWN_HOSTS_FILE)
}

pub fn load_known_hosts(app_dir: &Path) -> Result<Vec<KnownHost>, String> {
    let path = get_known_hosts_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read known hosts file: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse known hosts file: {}", e))
}

pub fn save_known_hosts(app_dir: &Path, hosts: &[KnownHost]) -> Result<(), String> {
    let path = get_known_hosts_path(app_dir);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path for known hosts file".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("Failed to serialize known hosts: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write known hosts file: {}", e))?;
    Ok(())
}

// --------------------------------------------------------------- history

pub fn get_action_history_path(app_dir: &Path) -> PathBuf {
    path_in(app_dir, ACTION_HISTORY_FILE)
}

pub fn load_action_history(app_dir: &Path) -> Result<Vec<ActionHistoryEntry>, String> {
    read_array(app_dir, ACTION_HISTORY_FILE, "action history")
}

pub fn save_action_history(app_dir: &Path, entries: &[ActionHistoryEntry]) -> Result<(), String> {
    write_array(app_dir, ACTION_HISTORY_FILE, "action history", entries)
}

pub fn append_history_entry(app_dir: &Path, entry: ActionHistoryEntry) -> Result<(), String> {
    let mut entries = load_action_history(app_dir)?;
    entries.push(entry);
    if entries.len() > MAX_HISTORY_ENTRIES {
        let drain_count = entries.len() - MAX_HISTORY_ENTRIES;
        entries.drain(0..drain_count);
    }
    save_action_history(app_dir, &entries)
}

pub fn get_cli_history_path(app_dir: &Path) -> PathBuf {
    path_in(app_dir, CLI_HISTORY_FILE)
}

/// Returns the newest-first history list.
pub fn load_cli_history(app_dir: &Path) -> Result<Vec<CliHistoryEntry>, String> {
    read_array(app_dir, CLI_HISTORY_FILE, "cli history")
}

pub fn save_cli_history(app_dir: &Path, entries: &[CliHistoryEntry]) -> Result<(), String> {
    write_array(app_dir, CLI_HISTORY_FILE, "cli history", entries)
}

pub fn append_cli_history_entry(app_dir: &Path, entry: CliHistoryEntry) -> Result<(), String> {
    let mut entries = load_cli_history(app_dir)?;
    entries.push(entry);
    if entries.len() > MAX_CLI_HISTORY_ENTRIES {
        let drain_count = entries.len() - MAX_CLI_HISTORY_ENTRIES;
        entries.drain(0..drain_count);
    }
    save_cli_history(app_dir, &entries)
}

// -------------------------------------------------------------- settings

/// Settings are a single object, not an array, so they get their own helpers.
pub fn load_settings_file<T>(app_dir: &Path) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
{
    let path = path_in(app_dir, SETTINGS_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {} file: {}", SETTINGS_FILE, e))?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("Failed to parse {} file: {}", SETTINGS_FILE, e))
}

pub fn save_settings_file<T>(app_dir: &Path, settings: &T) -> Result<(), String>
where
    T: Serialize,
{
    let path = path_in(app_dir, SETTINGS_FILE);
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path for {} file", SETTINGS_FILE))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write settings file: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ActionHistoryEntry, CliHistoryEntry};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ssh-thing-core-test-{}-{}-{}",
            name,
            std::process::id(),
            unix_timestamp_now().expect("timestamp")
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn missing_files_load_as_empty() {
        let dir = temp_dir("missing");
        assert!(load_servers(&dir).expect("servers").is_empty());
        assert!(load_snippets(&dir).expect("snippets").is_empty());
        assert!(load_actions(&dir).expect("actions").is_empty());
        assert!(load_known_hosts(&dir).expect("known hosts").is_empty());
        assert!(load_cli_history(&dir).expect("cli history").is_empty());
        assert!(load_settings_file::<serde_json::Value>(&dir)
            .expect("settings")
            .is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snippets_round_trip_with_scope() {
        let dir = temp_dir("snippets");
        let snippets = vec![
            Snippet {
                id: "a".to_string(),
                name: "Scoped".to_string(),
                command: "uptime".to_string(),
                description: None,
                server_id: Some("server-1".to_string()),
            },
            Snippet {
                id: "b".to_string(),
                name: "Global".to_string(),
                command: "ls".to_string(),
                description: Some("list".to_string()),
                server_id: None,
            },
        ];
        save_snippets(&dir, &snippets).expect("save");
        let loaded = load_snippets(&dir).expect("load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].server_id.as_deref(), Some("server-1"));
        assert!(loaded[1].server_id.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lenient_parse_skips_bad_records() {
        let data = r#"[{"id":"1","name":"ok","command":"ls"},{"nope":true}]"#;
        let parsed: Vec<Snippet> = parse_json_array_lenient(data, "snippets").expect("parse");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "1");
    }

    #[test]
    fn lenient_parse_errors_when_nothing_matches() {
        let data = r#"[{"nope":true}]"#;
        let result: Result<Vec<Snippet>, String> = parse_json_array_lenient(data, "snippets");
        assert!(result.is_err());
    }

    #[test]
    fn cli_history_is_capped_and_newest_last() {
        let dir = temp_dir("cli-history");
        for index in 0..(MAX_CLI_HISTORY_ENTRIES + 10) {
            append_cli_history_entry(
                &dir,
                CliHistoryEntry {
                    id: format!("entry-{index}"),
                    snippet_id: "snippet-1".to_string(),
                    snippet_name: "Snippet".to_string(),
                    server_id: "server-1".to_string(),
                    server_label: "prod".to_string(),
                    command: "true".to_string(),
                    started_at: index as u64,
                    completed_at: index as u64,
                    status: "success".to_string(),
                    exit_code: Some(0),
                    output: None,
                    error: None,
                    dry_run: false,
                },
            )
            .expect("append");
        }
        let entries = load_cli_history(&dir).expect("load");
        assert_eq!(entries.len(), MAX_CLI_HISTORY_ENTRIES);
        assert_eq!(
            entries.last().expect("last").id,
            format!("entry-{}", MAX_CLI_HISTORY_ENTRIES + 9)
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_action_history_without_exit_code_loads() {
        let dir = temp_dir("legacy-history");
        let data = r#"[{"id":"h","action_id":"a","action_name":"A","server_id":"s","server_label":"l","command":"c","started_at":1,"completed_at":2,"status":"success"}]"#;
        fs::write(get_action_history_path(&dir), data).expect("write");
        let entries = load_action_history(&dir).expect("load");
        assert_eq!(entries.len(), 1);
        assert!(entries[0].exit_code.is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn settings_round_trip() {
        let dir = temp_dir("settings");
        let settings = serde_json::json!({"allow_external_automation": true});
        save_settings_file(&dir, &settings).expect("save");
        let loaded: serde_json::Value = load_settings_file(&dir).expect("load").expect("present");
        assert_eq!(loaded["allow_external_automation"], serde_json::json!(true));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn action_history_entry_shape_is_shared() {
        let entry = ActionHistoryEntry {
            id: "h1".to_string(),
            action_id: "a1".to_string(),
            action_name: "Restart".to_string(),
            server_id: "s1".to_string(),
            server_label: "prod".to_string(),
            command: "systemctl restart api".to_string(),
            started_at: 1,
            completed_at: 2,
            status: "success".to_string(),
            exit_code: Some(0),
            output: Some("ok".to_string()),
            error: None,
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        let parsed: ActionHistoryEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.action_id, "a1");
    }
}

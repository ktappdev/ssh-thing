//! Serde data shapes shared by the desktop app and the CLI.
//!
//! These are the on-disk shapes. Anything added here must be
//! backwards-compatible with files written by older app versions: new fields
//! are `Option` or `#[serde(default)]` so old JSON still loads.

use serde::{Deserialize, Serialize};

pub const SERVERS_FILE: &str = "servers.json";
pub const SNIPPETS_FILE: &str = "snippets.json";
pub const ACTIONS_FILE: &str = "actions.json";
pub const ACTION_HISTORY_FILE: &str = "action-history.json";
pub const KNOWN_HOSTS_FILE: &str = "known_hosts.json";
pub const SETTINGS_FILE: &str = "settings.json";
pub const CLI_HISTORY_FILE: &str = "cli-history.json";

/// Desktop action history is capped at 250 entries.
pub const MAX_HISTORY_ENTRIES: usize = 250;
/// CLI history is append-only from an untrusted caller, so it gets its own cap.
pub const MAX_CLI_HISTORY_ENTRIES: usize = 500;
/// Output ceiling for one-shot command execution (both desktop actions and CLI).
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const TRUNCATION_MARKER: &str = "\n[output truncated]";

pub const DEFAULT_CONNECT_TIMEOUT_SECONDS: u64 = 30;
pub const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 60;
pub const MIN_COMMAND_TIMEOUT_SECONDS: u64 = 5;
pub const MAX_COMMAND_TIMEOUT_SECONDS: u64 = 600;

/// Version of the on-disk data shapes this build understands. Bump only when a
/// change is not backwards compatible; the CLI reports it in `version`.
pub const DATA_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStateEvent {
    pub connection_id: Option<String>,
    pub server_id: Option<String>,
    pub shell_id: Option<String>,
    pub state: ConnectionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub connection_id: Option<String>,
    pub server_id: Option<String>,
    pub shell_id: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConnection {
    pub id: String,
    #[serde(default)]
    pub nickname: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub last_connected_at: Option<u64>,
    pub auth: AuthMethod,
}

impl ServerConnection {
    /// Human label used in history entries and CLI output.
    pub fn label(&self) -> String {
        match &self.nickname {
            Some(name) if !name.trim().is_empty() => name.trim().to_string(),
            _ => format!("{}@{}:{}", self.user, self.host, self.port),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SecretKind {
    Password,
    PrivateKey,
}

fn default_secret_kind() -> SecretKind {
    SecretKind::Password
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    SecretRef {
        secret_id: String,
        #[serde(default = "default_secret_kind")]
        kind: SecretKind,
    },
    /// Legacy shape kept for migration into the keyring.
    Password { password: String },
    /// Legacy shape kept for migration into the keyring.
    Key { private_key: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    /// Server this snippet is scoped to. `None` is a legacy global snippet
    /// that only runs inside a live desktop session, never from the CLI.
    #[serde(default)]
    pub server_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key_base64: String,
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostKeyPrompt {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostKeyMismatch {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub stored_fingerprint: String,
}

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

/// History entry for a CLI `run`. Deliberately a separate file from
/// `action-history.json`: the shapes differ (snippets, not actions) and mixing
/// them would surface CLI runs inside the desktop Actions history list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliHistoryEntry {
    pub id: String,
    pub snippet_id: String,
    pub snippet_name: String,
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
    #[serde(default)]
    pub dry_run: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportData {
    pub version: String,
    pub exported_at: u64,
    pub snippets: Vec<Snippet>,
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub snippets_imported: usize,
    pub snippets_skipped: usize,
    pub actions_imported: usize,
    pub actions_skipped: usize,
}

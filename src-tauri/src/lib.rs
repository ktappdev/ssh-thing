use async_trait::async_trait;
use russh::client::{Config, Handle, Handler};
use russh::keys;
use russh::keys::PublicKeyBase64;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use keyring::Entry;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tracing::{debug, info};

const SERVERS_FILE: &str = "servers.json";
const SNIPPETS_FILE: &str = "snippets.json";
const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Error(String),
}

#[tauri::command]
async fn greet(name: String) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn get_servers(app: AppHandle) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    load_servers(&app_dir, &app)
}

#[tauri::command]
async fn update_server(
    app: AppHandle,
    id: String,
    server: ServerConnection,
) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir, &app)?;

    let index = servers
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("Server with id {} not found", id))?;

    let mut updated = server;
    migrate_server_auth(&app, &mut updated)?;
    servers[index] = updated;
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn trust_host_key(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    let host_key_id = format!("{}:{}", host, port);
    let state = app.state::<AppState>();

    let pending = {
        let mut pending_map = state.pending_host_keys.lock().await;
        pending_map.remove(&host_key_id)
    };

    let Some(pending) = pending else {
        return Err("No pending host key prompt".to_string());
    };

    let _ = pending.sender.send(true);

    let app_dir = get_app_dir(&app)?;
    let mut hosts = load_known_hosts(&app_dir)?;
    hosts.retain(|h| !(h.host == host && h.port == port));
    let added_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Time error: {}", e))?
        .as_secs();
    hosts.push(KnownHost {
        host,
        port,
        key_type: pending.key_type,
        fingerprint: pending.fingerprint,
        public_key_base64: pending.public_key_base64,
        added_at,
    });
    save_known_hosts(&app_dir, &hosts)
}

#[tauri::command]
async fn reject_host_key(app: AppHandle, host: String, port: u16) -> Result<(), String> {
    let host_key_id = format!("{}:{}", host, port);
    let state = app.state::<AppState>();

    let pending = {
        let mut pending_map = state.pending_host_keys.lock().await;
        pending_map.remove(&host_key_id)
    };

    if let Some(pending) = pending {
        let _ = pending.sender.send(false);
    }

    Ok(())
}

fn get_snippets_path(app_dir: &Path) -> PathBuf {
    app_dir.join(SNIPPETS_FILE)
}

fn load_snippets(app_dir: &Path) -> Result<Vec<Snippet>, String> {
    let path = get_snippets_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read snippets file: {}", e))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse snippets file: {}", e))
}

fn save_snippets(app_dir: &Path, snippets: &Vec<Snippet>) -> Result<(), String> {
    let path = get_snippets_path(app_dir);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path for snippets file".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(snippets)
        .map_err(|e| format!("Failed to serialize snippets: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write snippets file: {}", e))?;
    Ok(())
}

fn save_servers(app_dir: &Path, servers: &Vec<ServerConnection>) -> Result<(), String> {
    let path = get_servers_path(app_dir);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path for servers file".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(servers)
        .map_err(|e| format!("Failed to serialize servers: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write servers file: {}", e))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStateEvent {
    pub server_id: Option<String>,
    pub shell_id: Option<String>,
    pub state: ConnectionState,
}

pub struct SshClientHandler {
    app: AppHandle,
    host: String,
    port: u16,
    server_id: Option<String>,
}

fn emit_connection_state(
    app: &AppHandle,
    server_id: Option<&str>,
    shell_id: Option<&str>,
    state: ConnectionState,
) -> Result<(), String> {
    let payload = ConnectionStateEvent {
        server_id: server_id.map(|s| s.to_string()),
        shell_id: shell_id.map(|s| s.to_string()),
        state,
    };

    app.emit("connection-state", payload)
        .map_err(|e| format!("Failed to emit event: {}", e))
}

#[async_trait]
impl Handler for SshClientHandler {
    type Error = russh::Error;

    // NOTE: This currently accepts any server host key (similar to StrictHostKeyChecking=no).
    // For a real SSH client, implement TOFU/known_hosts persistence and prompt the user
    // before trusting a new key.
    async fn check_server_key(
        &mut self,
        server_public_key: &keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_type = server_public_key.name().to_string();
        let fingerprint = server_public_key.fingerprint();
        let public_key_base64 = server_public_key.public_key_base64();
        let host_key_id = format!("{}:{}", self.host, self.port);
        let server_id = self.server_id.as_deref();

        let app_dir = match get_app_dir(&self.app) {
            Ok(dir) => dir,
            Err(err) => {
                let _ = emit_connection_state(&self.app, server_id, None, ConnectionState::Error(err));
                return Ok(false);
            }
        };

        let known_hosts = match load_known_hosts(&app_dir) {
            Ok(hosts) => hosts,
            Err(err) => {
                let _ =
                    emit_connection_state(&self.app, server_id, None, ConnectionState::Error(err));
                return Ok(false);
            }
        };

        if let Some(known) = known_hosts
            .iter()
            .find(|entry| entry.host == self.host && entry.port == self.port)
        {
            if known.fingerprint == fingerprint && known.key_type == key_type {
                return Ok(true);
            }

            let mismatch = HostKeyMismatch {
                host: self.host.clone(),
                port: self.port,
                key_type,
                fingerprint,
                stored_fingerprint: known.fingerprint.clone(),
            };
            let _ = self.app.emit("host-key-mismatch", mismatch);
            return Ok(false);
        }

        let (tx, rx) = oneshot::channel();
        let pending = PendingHostKey {
            sender: tx,
            key_type: key_type.clone(),
            fingerprint: fingerprint.clone(),
            public_key_base64: public_key_base64.clone(),
        };

        let state = self.app.state::<AppState>();
        {
            let mut pending_map = state.pending_host_keys.lock().await;
            pending_map.insert(host_key_id.clone(), pending);
        }

        let prompt = HostKeyPrompt {
            host: self.host.clone(),
            port: self.port,
            key_type,
            fingerprint,
            public_key_base64,
        };
        let _ = self.app.emit("host-key-prompt", prompt);

        let decision = rx.await.unwrap_or(false);

        let state = self.app.state::<AppState>();
        let mut pending_map = state.pending_host_keys.lock().await;
        pending_map.remove(&host_key_id);

        Ok(decision)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConnection {
    pub id: String,
    #[serde(default)]
    pub nickname: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
}

fn keyring_service_name() -> String {
    "com.ssh-thing".to_string()
}

fn put_secret(_app: &AppHandle, secret_id: &str, secret: &str) -> Result<(), String> {
    let entry = Entry::new(&keyring_service_name(), secret_id)
        .map_err(|e| format!("keyring entry failed: {}", e))?;
    entry
        .set_password(secret)
        .map_err(|e| format!("keyring set failed: {}", e))?;
    Ok(())
}

fn get_secret(_app: &AppHandle, secret_id: &str) -> Result<String, String> {
    let entry = Entry::new(&keyring_service_name(), secret_id)
        .map_err(|e| format!("keyring entry failed: {}", e))?;
    entry
        .get_password()
        .map_err(|e| format!("keyring get failed: {}", e))
}

fn delete_secret(_app: &AppHandle, secret_id: &str) -> Result<(), String> {
    let entry = Entry::new(&keyring_service_name(), secret_id)
        .map_err(|e| format!("keyring entry failed: {}", e))?;
    entry
        .delete_password()
        .map_err(|e| format!("keyring delete failed: {}", e))
}

fn migrate_server_auth(app: &AppHandle, server: &mut ServerConnection) -> Result<(), String> {
    match &server.auth {
        AuthMethod::SecretRef { .. } => Ok(()),
        AuthMethod::Password { password } => {
            let secret_id = format!("server:{}:password", server.id);
            put_secret(app, &secret_id, password)?;
            server.auth = AuthMethod::SecretRef {
                secret_id,
                kind: SecretKind::Password,
            };
            Ok(())
        }
        AuthMethod::Key { private_key } => {
            let secret_id = format!("server:{}:private_key", server.id);
            put_secret(app, &secret_id, private_key)?;
            server.auth = AuthMethod::SecretRef {
                secret_id,
                kind: SecretKind::PrivateKey,
            };
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    // Legacy shapes kept for migration
    Password { password: String },
    Key { private_key: String },
}

pub type SshSession = Handle<SshClientHandler>;

#[derive(Debug, Clone)]
pub struct PtyShell {
    pub id: String,
    pub server_id: String,
    cmd_tx: mpsc::Sender<ShellCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyConfig {
    pub term: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub shell_id: String,
    pub output: String,
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

#[derive(Debug)]
enum ShellCommand {
    SendInput(String),
    Resize(u32, u32),
    Close,
}

impl Default for PtyConfig {
    fn default() -> Self {
        Self {
            term: "xterm-256color".to_string(),
            width: 80,
            height: 24,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json;

    #[test]
    fn test_server_connection_serialization() {
        let server = ServerConnection {
            id: "test-id".to_string(),
            nickname: Some("Test Server".to_string()),
            host: "192.168.1.1".to_string(),
            port: 22,
            user: "testuser".to_string(),
            auth: AuthMethod::Password {
                password: "testpass".to_string(),
            },
        };

        let json = serde_json::to_string(&server).expect("Failed to serialize");
        let deserialized: ServerConnection =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(server.id, deserialized.id);
        assert_eq!(server.host, deserialized.host);
        assert_eq!(server.port, deserialized.port);
        assert_eq!(server.user, deserialized.user);
        match (&server.auth, &deserialized.auth) {
            (AuthMethod::Password { password: p1 }, AuthMethod::Password { password: p2 }) => {
                assert_eq!(p1, p2);
            }
            _ => panic!("Auth method type mismatch"),
        }
    }

    #[test]
    fn test_key_auth_serialization() {
        let server = ServerConnection {
            id: "key-test".to_string(),
            nickname: None,
            host: "server.example.com".to_string(),
            port: 2222,
            user: "admin".to_string(),
            auth: AuthMethod::Key {
                private_key:
                    "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----"
                        .to_string(),
            },
        };

        let json = serde_json::to_string(&server).expect("Failed to serialize");
        let deserialized: ServerConnection =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(server.id, deserialized.id);
        assert_eq!(server.host, deserialized.host);
        match (&server.auth, &deserialized.auth) {
            (AuthMethod::Key { private_key: k1 }, AuthMethod::Key { private_key: k2 }) => {
                assert_eq!(k1, k2);
            }
            _ => panic!("Auth method type mismatch"),
        }
    }

    #[test]
    fn test_snippet_serialization() {
        let snippet = Snippet {
            id: "snippet-1".to_string(),
            name: "Test Snippet".to_string(),
            command: "echo hello".to_string(),
            description: Some("A test snippet".to_string()),
        };

        let json = serde_json::to_string(&snippet).expect("Failed to serialize");
        let deserialized: Snippet = serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(snippet.id, deserialized.id);
        assert_eq!(snippet.name, deserialized.name);
        assert_eq!(snippet.command, deserialized.command);
        assert_eq!(snippet.description, deserialized.description);
    }

    #[test]
    fn test_snippet_without_description() {
        let snippet = Snippet {
            id: "snippet-2".to_string(),
            name: "No Description".to_string(),
            command: "ls -la".to_string(),
            description: None,
        };

        let json = serde_json::to_string(&snippet).expect("Failed to serialize");
        let deserialized: Snippet = serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(snippet.id, deserialized.id);
        assert_eq!(snippet.name, deserialized.name);
        assert_eq!(snippet.description, deserialized.description);
    }

    #[test]
    fn test_pty_config_defaults() {
        let config = PtyConfig::default();

        assert_eq!(config.term, "xterm-256color");
        assert_eq!(config.width, 80);
        assert_eq!(config.height, 24);
    }

    #[test]
    fn test_connection_state_serialization() {
        let states = vec![
            ConnectionState::Connecting,
            ConnectionState::Connected,
            ConnectionState::Disconnected,
            ConnectionState::Error("Test error".to_string()),
        ];

        for state in states {
            let json = serde_json::to_string(&state).expect("Failed to serialize");
            let deserialized: ConnectionState =
                serde_json::from_str(&json).expect("Failed to deserialize");
            assert_eq!(state, deserialized);
        }
    }

    #[test]
    fn test_server_connection_with_different_ports() {
        let ports = vec![22, 2222, 443, 8080];

        for port in ports {
            let server = ServerConnection {
                id: format!("server-{}", port),
                nickname: None,
                host: "localhost".to_string(),
                port,
                user: "user".to_string(),
                auth: AuthMethod::Password {
                    password: "pass".to_string(),
                },
            };

            assert_eq!(server.port, port);

            let json = serde_json::to_string(&server).expect("Failed to serialize");
            let deserialized: ServerConnection =
                serde_json::from_str(&json).expect("Failed to deserialize");
            assert_eq!(deserialized.port, port);
        }
    }

    #[test]
    fn test_json_format_servers() {
        let servers = vec![
            ServerConnection {
                id: "1".to_string(),
                nickname: Some("Host 1".to_string()),
                host: "host1.com".to_string(),
                port: 22,
                user: "user1".to_string(),
                auth: AuthMethod::Password {
                    password: "pass1".to_string(),
                },
            },
            ServerConnection {
                id: "2".to_string(),
                nickname: Some("Host 2".to_string()),
                host: "host2.com".to_string(),
                port: 2222,
                user: "user2".to_string(),
                auth: AuthMethod::Key {
                    private_key: "key-data".to_string(),
                },
            },
        ];

        let json = serde_json::to_string_pretty(&servers).expect("Failed to serialize");
        let deserialized: Vec<ServerConnection> =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(servers.len(), deserialized.len());
        assert_eq!(servers[0].id, deserialized[0].id);
        assert_eq!(servers[1].id, deserialized[1].id);
    }

    #[test]
    fn test_tracing_debug_macro_compiles() {
        let host = "localhost";
        let port = 22u16;
        let user = "testuser";
        let auth_type = "password";

        tracing::debug!(host, port, user, auth_type, "Test debug message");
    }

    #[test]
    fn test_tracing_info_macro_compiles() {
        let host = "localhost";
        let port = 22u16;
        let user = "testuser";

        tracing::info!(host, port, user, "Test info message");
    }

    #[test]
    fn test_tracing_display_format() {
        let addr = format!("{}:{}", "localhost", 22);
        let display_addr = format!("{}", addr);

        tracing::debug!(%display_addr, "Address formatting");
    }

    #[test]
    fn test_pty_config_logging_fields() {
        let config = PtyConfig {
            term: "xterm-256color".to_string(),
            width: 80,
            height: 24,
        };

        tracing::debug!(
            term = %config.term,
            width = config.width,
            height = config.height,
            "PTY config logging"
        );
    }

    #[test]
    fn test_shell_id_logging() {
        let shell_id = "test-shell-123";
        let exit_status = 0u32;

        tracing::debug!(shell_id, "Read loop started");
        tracing::debug!(shell_id, "Read loop stopped");
        tracing::debug!(shell_id, exit_status, "Connection closed with exit status");
    }

    #[test]
    fn test_send_input_logging_fields() {
        let shell_id = "test-shell-456";
        let input_len = 10usize;

        tracing::debug!(shell_id, input_len, "Sending input");
    }

    #[tokio::test]
    async fn test_read_loop_data_message_handling() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<Result<String, String>>(100);

        let test_data = "test output data";
        let data_bytes = test_data.as_bytes();

        let result = std::str::from_utf8(data_bytes).map(|s| Ok(s.to_string()));
        tx.send(result.unwrap()).await.unwrap();

        let received = rx.recv().await.unwrap();
        assert!(received.is_ok());
        assert_eq!(received.unwrap(), test_data);
    }

    #[tokio::test]
    async fn test_read_loop_exit_status_handling() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<Result<String, String>>(100);

        let exit_status = 0u32;
        let expected_output = format!("\r\n\r\nConnection closed (exit code: {})\r\n", exit_status);

        tx.send(Ok(expected_output.clone())).await.unwrap();

        let received = rx.recv().await.unwrap();
        assert!(received.is_ok());
        assert_eq!(received.unwrap(), expected_output);
    }

    #[tokio::test]
    async fn test_read_loop_channel_error_handling() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<Result<String, String>>(100);

        tx.send(Err("Channel closed".to_string())).await.unwrap();

        let received = rx.recv().await.unwrap();
        assert!(received.is_err());
        assert_eq!(received.unwrap_err(), "Channel closed");
    }

    #[tokio::test]
    async fn test_read_loop_multiple_data_messages() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<Result<String, String>>(100);

        let messages = vec!["line1", "line2", "line3"];

        for msg in &messages {
            tx.send(Ok(msg.to_string())).await.unwrap();
        }

        for expected in messages {
            let received = rx.recv().await.unwrap();
            assert!(received.is_ok());
            assert_eq!(received.unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn test_read_loop_mpsc_channel_capacity() {
        use tokio::sync::mpsc;

        let (tx, mut rx) = mpsc::channel::<Result<String, String>>(100);

        for i in 0..10 {
            let msg = format!("message {}", i);
            tx.send(Ok(msg)).await.unwrap();
        }

        drop(tx);

        let mut count = 0;
        while let Some(result) = rx.recv().await {
            if result.is_ok() {
                count += 1;
            }
        }
        assert_eq!(count, 10);
    }

    #[test]
    fn test_terminal_output_serialization() {
        let terminal_output = TerminalOutput {
            shell_id: "test-shell-123".to_string(),
            output: "test output data".to_string(),
        };

        let json = serde_json::to_string(&terminal_output).expect("Failed to serialize");
        let deserialized: TerminalOutput =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(terminal_output.shell_id, deserialized.shell_id);
        assert_eq!(terminal_output.output, deserialized.output);
    }

    #[test]
    fn test_terminal_output_with_multiline_output() {
        let terminal_output = TerminalOutput {
            shell_id: "shell-456".to_string(),
            output: "line1\r\nline2\r\nline3".to_string(),
        };

        let json = serde_json::to_string(&terminal_output).expect("Failed to serialize");
        let deserialized: TerminalOutput =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(deserialized.shell_id, "shell-456");
        assert_eq!(deserialized.output, "line1\r\nline2\r\nline3");
    }

    #[test]
    fn test_terminal_output_empty_output() {
        let terminal_output = TerminalOutput {
            shell_id: "shell-789".to_string(),
            output: "".to_string(),
        };

        let json = serde_json::to_string(&terminal_output).expect("Failed to serialize");
        let deserialized: TerminalOutput =
            serde_json::from_str(&json).expect("Failed to deserialize");

        assert_eq!(deserialized.shell_id, "shell-789");
        assert_eq!(deserialized.output, "");
    }

    #[test]
    fn test_send_input_shell_not_found_error_message() {
        let shell_id = "non-existent-shell-123";
        let error_message = format!("Shell with id {} not found", shell_id);
        assert_eq!(
            error_message,
            "Shell with id non-existent-shell-123 not found"
        );
    }

    #[test]
    fn test_send_input_shell_lookup_in_hashmap() {
        use std::collections::HashMap;

        let mut shells: HashMap<String, String> = HashMap::new();

        let shell_id = "test-shell-456";
        shells.insert(shell_id.to_string(), "shell-data".to_string());

        let found_shell = shells.get(shell_id);
        assert!(found_shell.is_some());
        assert_eq!(found_shell.unwrap(), "shell-data");

        let not_found_shell = shells.get("non-existent");
        assert!(not_found_shell.is_none());
    }
}

struct AppState {
    sessions: Mutex<HashMap<String, SshSession>>,
    shells: Mutex<HashMap<String, PtyShell>>,
    pending_host_keys: Mutex<HashMap<String, PendingHostKey>>,
}

struct PendingHostKey {
    sender: oneshot::Sender<bool>,
    key_type: String,
    fingerprint: String,
    public_key_base64: String,
}

pub async fn connect_ssh(
    app: &AppHandle,
    host: &str,
    port: u16,
    user: &str,
    auth: &AuthMethod,
    server_id: Option<&str>,
) -> Result<SshSession, String> {
    let addr = format!("{}:{}", host, port);

    #[cfg(debug_assertions)]
    let auth_type = match auth {
        AuthMethod::SecretRef { kind, .. } => match kind {
            SecretKind::Password => "password",
            SecretKind::PrivateKey => "key",
        },
        AuthMethod::Password { .. } => "password",
        AuthMethod::Key { .. } => "key",
    };

    #[cfg(debug_assertions)]
    debug!(host, port, user, auth_type, "Starting SSH connection");

    emit_connection_state(app, server_id, None, ConnectionState::Connecting)?;

    let config = Arc::new(Config::default());

    #[cfg(debug_assertions)]
    debug!(%addr, "Establishing TCP connection");

    let handler = SshClientHandler {
        app: app.clone(),
        host: host.to_string(),
        port,
        server_id: server_id.map(|s| s.to_string()),
    };
    let mut session = russh::client::connect(config, addr, handler)
        .await
        .map_err(|e| {
            let _ = emit_connection_state(
                app,
                server_id,
                None,
                ConnectionState::Error(format!("Failed to connect: {}", e)),
            );
            format!("Failed to connect: {}", e)
        })?;

    match auth {
        AuthMethod::SecretRef { secret_id, kind } => match kind {
            SecretKind::Password => {
                let password = get_secret(app, secret_id)?;
                let auth_result = session
                    .authenticate_password(user, &password)
                    .await
                    .map_err(|e| {
                        let _ = emit_connection_state(
                            app,
                            server_id,
                            None,
                            ConnectionState::Error(format!("Authentication failed: {}", e)),
                        );
                        format!("Authentication failed: {}", e)
                    })?;

                if !auth_result {
                    let _ = emit_connection_state(
                        app,
                        server_id,
                        None,
                        ConnectionState::Error("Password authentication failed".to_string()),
                    );
                    return Err("Password authentication failed".to_string());
                }

                #[cfg(debug_assertions)]
                debug!(user, "Authenticated with secret ref (password)");
            }
            SecretKind::PrivateKey => {
                let key_data = get_secret(app, secret_id)?;
                let key_pair = keys::decode_secret_key(&key_data, None).map_err(|e| {
                    let _ = emit_connection_state(
                        app,
                        server_id,
                        None,
                        ConnectionState::Error(format!("Failed to decode private key: {}", e)),
                    );
                    format!("Failed to decode private key: {}", e)
                })?;

                let auth_result = session
                    .authenticate_publickey(user, Arc::new(key_pair))
                    .await
                    .map_err(|e| {
                        let _ = emit_connection_state(
                            app,
                            server_id,
                            None,
                            ConnectionState::Error(format!("Key authentication failed: {}", e)),
                        );
                        format!("Key authentication failed: {}", e)
                    })?;

                if !auth_result {
                    let _ = emit_connection_state(
                        app,
                        server_id,
                        None,
                        ConnectionState::Error("Key authentication failed".to_string()),
                    );
                    return Err("Key authentication failed".to_string());
                }

                #[cfg(debug_assertions)]
                debug!(user, "Authenticated with secret ref (key)");
            }
        },
        AuthMethod::Password { password } => {
            #[cfg(debug_assertions)]
            debug!(user, "Authenticating with password");

            let auth_result = session
                .authenticate_password(user, password)
                .await
                .map_err(|e| {
                    let _ = emit_connection_state(
                        app,
                        server_id,
                        None,
                        ConnectionState::Error(format!(
                            "Authentication failed: {}",
                            e
                        )),
                    );
                    format!("Authentication failed: {}", e)
                })?;

            if !auth_result {
                let _ = emit_connection_state(
                    app,
                    server_id,
                    None,
                    ConnectionState::Error("Password authentication failed".to_string()),
                );
                return Err("Password authentication failed".to_string());
            }

            #[cfg(debug_assertions)]
            debug!("Password authentication successful");
        }
        AuthMethod::Key { private_key } => {
            #[cfg(debug_assertions)]
            debug!(user, "Authenticating with key");

            let key_pair = keys::decode_secret_key(private_key, None).map_err(|e| {
                let _ = emit_connection_state(
                    app,
                    server_id,
                    None,
                    ConnectionState::Error(format!("Failed to decode private key: {}", e)),
                );
                format!("Failed to decode private key: {}", e)
            })?;

            let auth_result = session
                .authenticate_publickey(user, Arc::new(key_pair))
                .await
                .map_err(|e| {
                    let _ = emit_connection_state(
                        app,
                        server_id,
                        None,
                        ConnectionState::Error(format!("Key authentication failed: {}", e)),
                    );
                    format!("Key authentication failed: {}", e)
                })?;

            if !auth_result {
                let _ = emit_connection_state(
                    app,
                    server_id,
                    None,
                    ConnectionState::Error("Key authentication failed".to_string()),
                );
                return Err("Key authentication failed".to_string());
            }

            #[cfg(debug_assertions)]
            debug!("Key authentication successful");
        }
    }

    #[cfg(debug_assertions)]
    info!(host, port, user, "SSH connection established successfully");

    emit_connection_state(app, server_id, None, ConnectionState::Connected)?;

    Ok(session)
}

pub async fn disconnect_ssh(
    app: &AppHandle,
    session: Option<SshSession>,
    server_id: Option<&str>,
) -> Result<(), String> {
    if let Some(s) = session {
        let disconnect_result = timeout(
            Duration::from_secs(2),
            s.disconnect(russh::Disconnect::ByApplication, "disconnected", "en"),
        )
        .await;

        if disconnect_result.is_err() {
            #[cfg(debug_assertions)]
            debug!(server_id = server_id, "SSH disconnect timed out");
        }
    }
    emit_connection_state(app, server_id, None, ConnectionState::Disconnected)?;
    Ok(())
}

pub async fn open_pty_shell(
    app: &AppHandle,
    session: &mut SshSession,
    config: &PtyConfig,
    server_id: &str,
) -> Result<PtyShell, String> {
    #[cfg(debug_assertions)]
    debug!(server_id, term = %config.term, width = config.width, height = config.height, "Opening PTY shell channel");

    emit_connection_state(app, Some(server_id), None, ConnectionState::Connected)?;

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open channel: {}", e))?;

    #[cfg(debug_assertions)]
    debug!("Channel opened, requesting PTY");

    channel
        .request_pty(false, &config.term, config.width, config.height, 0, 0, &[])
        .await
        .map_err(|e| format!("Failed to request PTY: {}", e))?;

    #[cfg(debug_assertions)]
    debug!("PTY requested, requesting shell");

    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("Failed to request shell: {}", e))?;

    #[cfg(debug_assertions)]
    debug!(server_id, "Shell channel ready");

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<ShellCommand>(100);
    let shell_id = uuid::Uuid::new_v4().to_string();
    let shell_id_for_task = shell_id.clone();
    let server_id_for_task = server_id.to_string();
    let mut channel_for_task = channel;
    let app_for_task = app.clone();

    emit_connection_state(
        app,
        Some(server_id),
        Some(&shell_id),
        ConnectionState::Connected,
    )?;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel_for_task.wait() => {
                    let Some(msg) = msg else {
                        #[cfg(debug_assertions)]
                        debug!(shell_id = %shell_id_for_task, "Read loop stopped");
                        break;
                    };

                    match msg {
                        russh::ChannelMsg::Data { ref data } => {
                            if let Ok(s) = std::str::from_utf8(data) {
                                let payload = TerminalOutput {
                                    shell_id: shell_id_for_task.clone(),
                                    output: s.to_string(),
                                };
                                let _ = app_for_task.emit("terminal-output", payload);
                            }
                        }
                        russh::ChannelMsg::ExitStatus { exit_status } => {
                            let output =
                                format!("\r\n\r\nConnection closed (exit code: {})\r\n", exit_status);
                            #[cfg(debug_assertions)]
                            debug!(
                                shell_id = %shell_id_for_task,
                                exit_status,
                                "Connection closed with exit status"
                            );
                            let payload = TerminalOutput {
                                shell_id: shell_id_for_task.clone(),
                                output,
                            };
                            let _ = app_for_task.emit("terminal-output", payload);
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(ShellCommand::SendInput(input)) => {
                            if let Err(e) = channel_for_task.data(input.as_bytes()).await {
                                #[cfg(debug_assertions)]
                                debug!(shell_id = %shell_id_for_task, error = %e, "Failed to send input");
                                let _ = app_for_task.emit(
                                    "terminal-output",
                                    TerminalOutput {
                                        shell_id: shell_id_for_task.clone(),
                                        output: format!("\r\nFailed to send input: {}\r\n", e),
                                    },
                                );
                            }
                        }
                        Some(ShellCommand::Resize(width, height)) => {
                            if let Err(e) = channel_for_task.window_change(width, height, 0, 0).await {
                                #[cfg(debug_assertions)]
                                debug!(
                                    shell_id = %shell_id_for_task,
                                    width,
                                    height,
                                    error = %e,
                                    "Failed to resize shell"
                                );
                            }
                        }
                        Some(ShellCommand::Close) | None => {
                            let _ = channel_for_task.close().await;
                            break;
                        }
                    }
                }
            }
        }
        let _ = emit_connection_state(
            &app_for_task,
            Some(server_id_for_task.as_str()),
            Some(shell_id_for_task.as_str()),
            ConnectionState::Disconnected,
        );
    });

    let shell = PtyShell {
        id: shell_id,
        server_id: server_id.to_string(),
        cmd_tx,
    };

    Ok(shell)
}

fn get_servers_path(app_dir: &Path) -> PathBuf {
    app_dir.join(SERVERS_FILE)
}

fn get_known_hosts_path(app_dir: &Path) -> PathBuf {
    app_dir.join(KNOWN_HOSTS_FILE)
}

fn get_app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

fn load_known_hosts(app_dir: &Path) -> Result<Vec<KnownHost>, String> {
    let path = get_known_hosts_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read known hosts file: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse known hosts file: {}", e))
}

fn save_known_hosts(app_dir: &Path, hosts: &[KnownHost]) -> Result<(), String> {
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

fn load_servers(app_dir: &Path, app: &AppHandle) -> Result<Vec<ServerConnection>, String> {
    let path = get_servers_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read servers file: {}", e))?;
    let mut servers: Vec<ServerConnection> = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to deserialize servers: {}", e))?;

    // Migrate any plaintext secrets into keyring
    let mut changed = false;
    for server in servers.iter_mut() {
        if let AuthMethod::SecretRef { .. } = server.auth {
            continue;
        }
        migrate_server_auth(app, server)?;
        changed = true;
    }

    if changed {
        save_servers(app_dir, &servers)?;
    }

    Ok(servers)
}

#[tauri::command]
async fn upsert_secret(
    app: AppHandle,
    secret_id: Option<String>,
    secret: String,
    kind: SecretKind,
) -> Result<String, String> {
    // kind is included for future use (password vs key) even though keyring storage is the same
    let _ = kind;
    let id = secret_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    put_secret(&app, &id, &secret)?;
    // storing kind is implicit in the calling AuthMethod
    Ok(id)
}

#[tauri::command]
async fn add_server(app: AppHandle, server: ServerConnection) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir, &app)?;
    let mut server = server;
    migrate_server_auth(&app, &mut server)?;
    servers.push(server);
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn delete_server(app: AppHandle, id: String) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir, &app)?;
    let index = servers
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("Server with id {} not found", id))?;

    if let AuthMethod::SecretRef { secret_id, .. } = &servers[index].auth {
        let _ = delete_secret(&app, secret_id);
    }

    servers.remove(index);
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn get_snippets(app: AppHandle) -> Result<Vec<Snippet>, String> {
    let app_dir = get_app_dir(&app)?;
    load_snippets(&app_dir)
}

#[tauri::command]
async fn add_snippet(app: AppHandle, snippet: Snippet) -> Result<Vec<Snippet>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut snippets = load_snippets(&app_dir)?;
    snippets.push(snippet);
    save_snippets(&app_dir, &snippets)?;
    Ok(snippets)
}

#[tauri::command]
async fn update_snippet(
    app: AppHandle,
    id: String,
    snippet: Snippet,
) -> Result<Vec<Snippet>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut snippets = load_snippets(&app_dir)?;
    let index = snippets
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("Snippet with id {} not found", id))?;
    snippets[index] = snippet;
    save_snippets(&app_dir, &snippets)?;
    Ok(snippets)
}

#[tauri::command]
async fn delete_snippet(app: AppHandle, id: String) -> Result<Vec<Snippet>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut snippets = load_snippets(&app_dir)?;
    let index = snippets
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("Snippet with id {} not found", id))?;
    snippets.remove(index);
    save_snippets(&app_dir, &snippets)?;
    Ok(snippets)
}

#[tauri::command]
async fn connect(app: AppHandle, server: ServerConnection) -> Result<String, String> {
    let session =
        connect_ssh(&app, &server.host, server.port, &server.user, &server.auth, Some(&server.id))
            .await?;
    let state = app.state::<AppState>();

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(server.id.clone(), session);
    }

    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&server.id)
        .ok_or_else(|| format!("Session not found"))?;

    let config = PtyConfig::default();
    let shell = open_pty_shell(&app, session, &config, &server.id).await?;

    let shell_id = shell.id.clone();

    {
        let mut shells = state.shells.lock().await;
        shells.insert(shell_id.clone(), shell);
    }

    Ok(shell_id)
}

#[tauri::command]
async fn disconnect(app: AppHandle, server_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();

    let session = {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(&server_id)
    };

    let shell_ids: Vec<String> = {
        let shells = state.shells.lock().await;
        shells
            .iter()
            .filter(|(_, shell)| shell.server_id == server_id)
            .map(|(id, _)| id.clone())
            .collect()
    };

    for shell_id in shell_ids {
        let cmd_tx = {
            let mut shells = state.shells.lock().await;
            shells.remove(&shell_id).map(|shell| shell.cmd_tx)
        };

        if let Some(tx) = cmd_tx {
            let _ = timeout(Duration::from_millis(250), tx.send(ShellCommand::Close)).await;
        }
    }

    disconnect_ssh(&app, session, Some(&server_id)).await
}

#[tauri::command]
async fn send_input(app: AppHandle, shell_id: String, input: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    let input_len = input.len();

    #[cfg(debug_assertions)]
    debug!(shell_id, input_len, "Sending input");

    let state = app.state::<AppState>();
    let cmd_tx = {
        let shells = state.shells.lock().await;
        shells
            .get(&shell_id)
            .map(|shell| shell.cmd_tx.clone())
            .ok_or_else(|| format!("Shell with id {} not found", shell_id))?
    };

    cmd_tx
        .send(ShellCommand::SendInput(input))
        .await
        .map_err(|e| format!("Failed to send input: {}", e))
}

#[tauri::command]
async fn resize(app: AppHandle, shell_id: String, width: u32, height: u32) -> Result<(), String> {
    let state = app.state::<AppState>();
    let cmd_tx = {
        let shells = state.shells.lock().await;
        shells
            .get(&shell_id)
            .map(|shell| shell.cmd_tx.clone())
            .ok_or_else(|| format!("Shell with id {} not found", shell_id))?
    };

    cmd_tx
        .send(ShellCommand::Resize(width, height))
        .await
        .map_err(|e| format!("Failed to resize shell: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            sessions: Mutex::new(HashMap::new()),
            shells: Mutex::new(HashMap::new()),
            pending_host_keys: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_servers,
            add_server,
            update_server,
            delete_server,
            get_snippets,
            add_snippet,
            update_snippet,
            delete_snippet,
            upsert_secret,
            trust_host_key,
            reject_host_key,
            connect,
            disconnect,
            send_input,
            resize
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

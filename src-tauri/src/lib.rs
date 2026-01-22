use async_trait::async_trait;
use russh::client::{Config, Handle, Handler, Msg};
use russh::keys;
use russh::Channel;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tracing::{debug, info};

const SERVERS_FILE: &str = "servers.json";
const SNIPPETS_FILE: &str = "snippets.json";
const SNIPPETS_TOML_FILE: &str = "snippets.toml";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Error(String),
}

pub struct SshClientHandler;

#[async_trait]
impl Handler for SshClientHandler {
    type Error = russh::Error;

    // NOTE: This currently accepts any server host key (similar to StrictHostKeyChecking=no).
    // For a real SSH client, implement TOFU/known_hosts persistence and prompt the user
    // before trusting a new key.
    async fn check_server_key(
        &mut self,
        _server_public_key: &keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthMethod {
    Password { password: String },
    Key { private_key: String },
}

pub type SshSession = Handle<SshClientHandler>;

#[derive(Debug, Clone)]
pub struct PtyShell {
    pub channel: Arc<Mutex<Channel<Msg>>>,
    pub id: String,
    pub server_id: String,
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
struct SnippetsToml {
    snippets: Vec<Snippet>,
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
                host: "host1.com".to_string(),
                port: 22,
                user: "user1".to_string(),
                auth: AuthMethod::Password {
                    password: "pass1".to_string(),
                },
            },
            ServerConnection {
                id: "2".to_string(),
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
}

struct AppState {
    sessions: Mutex<HashMap<String, SshSession>>,
    shells: Mutex<HashMap<String, PtyShell>>,
}

pub async fn connect_ssh(
    app: &AppHandle,
    host: &str,
    port: u16,
    user: &str,
    auth: &AuthMethod,
) -> Result<SshSession, String> {
    let addr = format!("{}:{}", host, port);

    #[cfg(debug_assertions)]
    let auth_type = match auth {
        AuthMethod::Password { .. } => "password",
        AuthMethod::Key { .. } => "key",
    };

    #[cfg(debug_assertions)]
    debug!(host, port, user, auth_type, "Starting SSH connection");

    app.emit("connection-state", ConnectionState::Connecting)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    let config = Arc::new(Config::default());

    #[cfg(debug_assertions)]
    debug!(%addr, "Establishing TCP connection");

    let mut session = russh::client::connect(config, addr, SshClientHandler)
        .await
        .map_err(|e| {
            let _ = app.emit(
                "connection-state",
                ConnectionState::Error(format!("Failed to connect: {}", e)),
            );
            format!("Failed to connect: {}", e)
        })?;

    match auth {
        AuthMethod::Password { password } => {
            #[cfg(debug_assertions)]
            debug!(user, "Authenticating with password");

            let auth_result = session
                .authenticate_password(user, password)
                .await
                .map_err(|e| {
                    let _ = app.emit(
                        "connection-state",
                        ConnectionState::Error(format!("Authentication failed: {}", e)),
                    );
                    format!("Authentication failed: {}", e)
                })?;

            if !auth_result {
                let _ = app.emit(
                    "connection-state",
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
                let _ = app.emit(
                    "connection-state",
                    ConnectionState::Error(format!("Failed to decode private key: {}", e)),
                );
                format!("Failed to decode private key: {}", e)
            })?;

            let auth_result = session
                .authenticate_publickey(user, Arc::new(key_pair))
                .await
                .map_err(|e| {
                    let _ = app.emit(
                        "connection-state",
                        ConnectionState::Error(format!("Key authentication failed: {}", e)),
                    );
                    format!("Key authentication failed: {}", e)
                })?;

            if !auth_result {
                let _ = app.emit(
                    "connection-state",
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

    app.emit("connection-state", ConnectionState::Connected)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

    Ok(session)
}

pub async fn disconnect_ssh(app: &AppHandle, session: Option<SshSession>) -> Result<(), String> {
    if let Some(s) = session {
        let _ = s
            .disconnect(russh::Disconnect::ByApplication, "disconnected", "en")
            .await;
    }
    app.emit("connection-state", ConnectionState::Disconnected)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
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

    app.emit("connection-state", ConnectionState::Connected)
        .map_err(|e| format!("Failed to emit event: {}", e))?;

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

    let shell = PtyShell {
        channel: Arc::new(Mutex::new(channel)),
        id: uuid::Uuid::new_v4().to_string(),
        server_id: server_id.to_string(),
    };

    Ok(shell)
}

fn get_servers_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join(SERVERS_FILE)
}

fn get_app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

fn load_servers(app_dir: &PathBuf) -> Result<Vec<ServerConnection>, String> {
    let path = get_servers_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read servers file: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse servers file: {}", e))
}

fn save_servers(app_dir: &PathBuf, servers: &[ServerConnection]) -> Result<(), String> {
    let path = get_servers_path(app_dir);
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path for servers file"))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(servers)
        .map_err(|e| format!("Failed to serialize servers: {}", e))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write servers file: {}", e))?;
    Ok(())
}

fn get_snippets_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join(SNIPPETS_FILE)
}

fn get_snippets_toml_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join(SNIPPETS_TOML_FILE)
}

fn load_snippets(app_dir: &PathBuf) -> Result<Vec<Snippet>, String> {
    let toml_path = get_snippets_toml_path(app_dir);
    let json_path = get_snippets_path(app_dir);

    if toml_path.exists() {
        let content = fs::read_to_string(&toml_path)
            .map_err(|e| format!("Failed to read snippets TOML file: {}", e))?;
        let toml_data: SnippetsToml = toml::from_str(&content)
            .map_err(|e| format!("Failed to parse snippets TOML file: {}", e))?;
        return Ok(toml_data.snippets);
    }

    if !json_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&json_path)
        .map_err(|e| format!("Failed to read snippets file: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse snippets file: {}", e))
}

fn save_snippets(app_dir: &PathBuf, snippets: &[Snippet]) -> Result<(), String> {
    let toml_path = get_snippets_toml_path(app_dir);
    let parent = toml_path
        .parent()
        .ok_or_else(|| format!("Invalid path for snippets file"))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let toml_data = SnippetsToml {
        snippets: snippets.to_vec(),
    };
    let content = toml::to_string_pretty(&toml_data)
        .map_err(|e| format!("Failed to serialize snippets to TOML: {}", e))?;
    fs::write(&toml_path, content)
        .map_err(|e| format!("Failed to write snippets TOML file: {}", e))?;
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn get_servers(app: AppHandle) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    load_servers(&app_dir)
}

#[tauri::command]
async fn add_server(
    app: AppHandle,
    server: ServerConnection,
) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir)?;
    servers.push(server);
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn update_server(
    app: AppHandle,
    id: String,
    server: ServerConnection,
) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir)?;
    let index = servers
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("Server with id {} not found", id))?;
    servers[index] = server;
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn delete_server(app: AppHandle, id: String) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir)?;
    let index = servers
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| format!("Server with id {} not found", id))?;
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
    let session = connect_ssh(&app, &server.host, server.port, &server.user, &server.auth).await?;
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

    let app_clone = app.clone();
    let channel = shell.channel.clone();
    let shell_id = shell.id.clone();

    #[cfg(debug_assertions)]
    debug!(shell_id, "Starting read loop");

    tokio::spawn(async move {
        let mut channel_guard = channel.lock().await;
        loop {
            let msg = channel_guard.wait().await;
            let Some(msg) = msg else {
                #[cfg(debug_assertions)]
                debug!(shell_id, "Read loop stopped");
                break;
            };
            match msg {
                russh::ChannelMsg::Data { ref data } => {
                    drop(channel_guard);
                    if let Ok(s) = std::str::from_utf8(data) {
                        let _ = app_clone.emit("terminal-output", s);
                    }
                    channel_guard = channel.lock().await;
                }
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    drop(channel_guard);
                    let _ = app_clone.emit(
                        "terminal-output",
                        format!("\r\n\r\nConnection closed (exit code: {})\r\n", exit_status),
                    );
                    #[cfg(debug_assertions)]
                    debug!(shell_id, exit_status, "Connection closed with exit status");
                    break;
                }
                _ => {
                    channel_guard = channel.lock().await;
                }
            }
        }
    });

    let shell_id = shell.id.clone();
    let mut shells = state.shells.lock().await;
    shells.insert(shell_id.clone(), shell);

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
        let shell = {
            let mut shells = state.shells.lock().await;
            shells.remove(&shell_id)
        };
        if let Some(shell) = shell {
            let channel = shell.channel.lock().await;
            let _ = channel.close().await;
        }
    }

    disconnect_ssh(&app, session).await
}

#[tauri::command]
async fn send_input(app: AppHandle, shell_id: String, input: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    let input_len = input.len();

    #[cfg(debug_assertions)]
    debug!(shell_id, input_len, "Sending input");

    let state = app.state::<AppState>();
    let shells = state.shells.lock().await;
    let shell = shells
        .get(&shell_id)
        .ok_or_else(|| format!("Shell with id {} not found", shell_id))?;

    let channel = shell.channel.lock().await;
    channel
        .data(input.as_bytes())
        .await
        .map_err(|e| format!("Failed to send input: {}", e))
}

#[tauri::command]
async fn resize(app: AppHandle, shell_id: String, width: u32, height: u32) -> Result<(), String> {
    let state = app.state::<AppState>();
    let shells = state.shells.lock().await;
    let shell = shells
        .get(&shell_id)
        .ok_or_else(|| format!("Shell with id {} not found", shell_id))?;

    let channel = shell.channel.lock().await;
    channel
        .request_pty(false, "xterm-256color", width, height, 0, 0, &[])
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
            connect,
            disconnect,
            send_input,
            resize
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

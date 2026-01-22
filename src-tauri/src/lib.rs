use russh::client::{Config, Handler, Handle, Msg};
use russh::keys;
use russh::Channel;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

const SERVERS_FILE: &str = "servers.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
    Error(String),
}

pub struct SshClientHandler;

impl Handler for SshClientHandler {
    type Error = russh::Error;
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

#[derive(Debug)]
pub struct PtyShell {
    pub channel: Channel<Msg>,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyConfig {
    pub term: String,
    pub width: u32,
    pub height: u32,
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

pub async fn connect_ssh(
    app: &AppHandle,
    host: &str,
    port: u16,
    user: &str,
    auth: &AuthMethod,
) -> Result<SshSession, String> {
    app.emit("connection-state", ConnectionState::Connecting)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    
    let config = Arc::new(Config::default());
    let addr = format!("{}:{}", host, port);
    
    let mut session = russh::client::connect(config, addr, SshClientHandler)
        .await
        .map_err(|e| {
            let _ = app.emit("connection-state", ConnectionState::Error(format!("Failed to connect: {}", e)));
            format!("Failed to connect: {}", e)
        })?;
    
    match auth {
        AuthMethod::Password { password } => {
            let auth_result = session
                .authenticate_password(user, password)
                .await
                .map_err(|e| {
                    let _ = app.emit("connection-state", ConnectionState::Error(format!("Authentication failed: {}", e)));
                    format!("Authentication failed: {}", e)
                })?;
            
            if !auth_result {
                let _ = app.emit("connection-state", ConnectionState::Error("Password authentication failed".to_string()));
                return Err("Password authentication failed".to_string());
            }
        }
        AuthMethod::Key { private_key } => {
            let key_pair = keys::decode_secret_key(private_key, None)
                .map_err(|e| {
                    let _ = app.emit("connection-state", ConnectionState::Error(format!("Failed to decode private key: {}", e)));
                    format!("Failed to decode private key: {}", e)
                })?;
            
            let auth_result = session
                .authenticate_publickey(user, Arc::new(key_pair))
                .await
                .map_err(|e| {
                    let _ = app.emit("connection-state", ConnectionState::Error(format!("Key authentication failed: {}", e)));
                    format!("Key authentication failed: {}", e)
                })?;
            
            if !auth_result {
                let _ = app.emit("connection-state", ConnectionState::Error("Key authentication failed".to_string()));
                return Err("Key authentication failed".to_string());
            }
        }
    }
    
    app.emit("connection-state", ConnectionState::Connected)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(session)
}

pub async fn disconnect_ssh(app: &AppHandle) -> Result<(), String> {
    app.emit("connection-state", ConnectionState::Disconnected)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    Ok(())
}

pub async fn open_pty_shell(
    app: &AppHandle,
    session: &mut SshSession,
    config: &PtyConfig,
) -> Result<PtyShell, String> {
    app.emit("connection-state", ConnectionState::Connected)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Failed to open channel: {}", e))?;
    
    channel
        .request_pty(
            false,
            &config.term,
            config.width,
            config.height,
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| format!("Failed to request PTY: {}", e))?;
    
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("Failed to request shell: {}", e))?;
    
    let shell = PtyShell {
        channel,
        id: uuid::Uuid::new_v4().to_string(),
    };
    
    Ok(shell)
}


fn get_servers_path(app_dir: &PathBuf) -> PathBuf {
    app_dir.join(SERVERS_FILE)
}

fn get_app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

fn load_servers(app_dir: &PathBuf) -> Result<Vec<ServerConnection>, String> {
    let path = get_servers_path(app_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read servers file: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse servers file: {}", e))
}

fn save_servers(app_dir: &PathBuf, servers: &[ServerConnection]) -> Result<(), String> {
    let path = get_servers_path(app_dir);
    let parent = path.parent()
        .ok_or_else(|| format!("Invalid path for servers file"))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    let content = serde_json::to_string_pretty(servers)
        .map_err(|e| format!("Failed to serialize servers: {}", e))?;
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write servers file: {}", e))?;
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
async fn add_server(app: AppHandle, server: ServerConnection) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir)?;
    servers.push(server);
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn update_server(app: AppHandle, id: String, server: ServerConnection) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir)?;
    let index = servers.iter().position(|s| s.id == id)
        .ok_or_else(|| format!("Server with id {} not found", id))?;
    servers[index] = server;
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn delete_server(app: AppHandle, id: String) -> Result<Vec<ServerConnection>, String> {
    let app_dir = get_app_dir(&app)?;
    let mut servers = load_servers(&app_dir)?;
    let index = servers.iter().position(|s| s.id == id)
        .ok_or_else(|| format!("Server with id {} not found", id))?;
    servers.remove(index);
    save_servers(&app_dir, &servers)?;
    Ok(servers)
}

#[tauri::command]
async fn connect_to_server(app: AppHandle, server: ServerConnection) -> Result<String, String> {
    let _session = connect_ssh(&app, &server.host, server.port, &server.user, &server.auth).await?;
    Ok(format!("Connected to {}", server.host))
}

#[tauri::command]
async fn disconnect_from_server(app: AppHandle) -> Result<(), String> {
    disconnect_ssh(&app).await
}

#[tauri::command]
async fn open_shell(
    app: AppHandle,
    server: ServerConnection,
    config: Option<PtyConfig>,
) -> Result<String, String> {
    let pty_config = config.unwrap_or_default();
    let mut session = connect_ssh(&app, &server.host, server.port, &server.user, &server.auth).await?;
    
    let _channel = open_pty_shell(&app, &mut session, &pty_config).await?;
    
    Ok(format!("PTY shell opened on {}", server.host))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_servers,
            add_server,
            update_server,
            delete_server,
            connect_to_server,
            disconnect_from_server,
            open_shell
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

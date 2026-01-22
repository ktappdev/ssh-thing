use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SERVERS_FILE: &str = "servers.json";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_servers,
            add_server,
            update_server,
            delete_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

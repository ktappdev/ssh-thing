# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Common commands

Use either the Node/Tauri CLI or the Cargo plugin. The repo currently tracks npm via `package-lock.json`, but pnpm and Cargo work fine.

- Dev (hot reload):
  - pnpm: `pnpm tauri dev`
  - npm: `npx tauri dev` (or `npm run tauri -- dev`)
  - Cargo: `cargo tauri dev`

- Build (production bundle):
  - pnpm: `pnpm tauri build`
  - npm: `npx tauri build`
  - Cargo: `cargo tauri build`

- Platform-specific bundles (examples):
  - macOS: `pnpm tauri build -- --target x86_64-apple-darwin`
  - Windows: `pnpm tauri build -- --target x86_64-pc-windows-msvc`
  - Linux (AppImage): `pnpm tauri build -- --target x86_64-unknown-linux-gnu --bundler appimage`
  - Linux (deb): `pnpm tauri build -- --target x86_64-unknown-linux-gnu --bundler deb`

- Rust crate (backend in `src-tauri/`):
  - Check: `cargo check`
  - Lint: `cargo clippy` (add `-D warnings` to fail on warnings)
  - Format: `cargo fmt`
  - Test (all): `cargo test`
  - Test (single): `cargo test -p tauri-app test_name`

## Architecture overview

This is a Tauri 2 workspace with a Rust backend and a vanilla HTML/JS frontend.

- Workspace layout
  - Root Cargo workspace points to `src-tauri/` (Rust crate `tauri-app`).
  - Frontend assets live in `frontend/` and are served via Tauri (`frontendDist: ../frontend`).

- Backend (Rust, `src-tauri/src/`)
  - Entry: `main.rs` calls `tauri_app_lib::run()`; `lib.rs` builds the app.
  - State: `AppState` manages SSH sessions and PTY shells via `tokio::sync::Mutex<HashMap<...>>`.
  - Commands (exposed to frontend with `#[tauri::command]`):
    - Server CRUD: `get_servers`, `add_server`, `update_server`, `delete_server`.
    - Snippet CRUD: `get_snippets`, `add_snippet`, `update_snippet`, `delete_snippet`.
    - SSH lifecycle: `connect`, `disconnect`, terminal I/O: `send_input`, `resize`.
  - Events emitted to the frontend:
    - `connection-state` with `ConnectionState` enum: `Connecting | Connected | Disconnected | Error(String)`.
    - `terminal-output` streams shell data.
  - SSH implementation (russh):
    - `connect_ssh()` authenticates via `AuthMethod::Password` or `AuthMethod::Key` (decoded with `russh::keys`).
    - `open_pty_shell()` opens a session channel, requests a PTY, and spawns a task to forward output as events.
  - Persistence (app data dir):
    - Servers stored as JSON: `servers.json`.
    - Snippets prefer TOML (`snippets.toml` via `SnippetsToml`); falls back to JSON `snippets.json` if TOML absent.

- Frontend (vanilla JS, `frontend/`)
  - UI: `index.html` (Tailwind via CDN) + `main.js` (Xterm.js + Fit addon). Sidebars manage Servers and Snippets; main pane hosts the terminal.
  - Bridge:
    - Calls backend via `window.__TAURI__.core.invoke` for commands above.
    - Subscribes to `connection-state` and `terminal-output` via `window.__TAURI__.event.listen`.
  - Terminal behavior:
    - Writes keystrokes to `send_input` (handles common Ctrl/Meta combos).
    - Auto-fit on resize; optional auto-scroll to bottom.

- Configuration (Tauri, `src-tauri/tauri.conf.json`)
  - `productName: ssh-thing`, `identifier: com.kentaylor.ssh-thing`.
  - Window: 1200×800 (min 800×600), `withGlobalTauri: true`.
  - Bundling: `targets: "all"`, icons under `src-tauri/icons/`.
  - Linux packaging provides dependencies for deb/rpm; macOS minimum 11.0.

## Project conventions (from AGENTS.md)

- Rust style
  - Use `cargo fmt`; `snake_case` for items, `PascalCase` for types; avoid `unwrap/expect` in app code.
  - Fallible functions exposed to UI return `Result<T, String>` with contextual `.map_err(...)`.
  - Use `tokio::sync::Mutex` for async state; derive `Debug, Clone, Serialize, Deserialize` where appropriate; tagged enums via `#[serde(tag = "type")]`.
- Tauri integration
  - Mark commands with `#[tauri::command]`; obtain state via `app.state::<AppState>()`; emit events with `app.emit(...)`.
- Testing
  - Unit tests colocated in the same file under `#[cfg(test)]` (see examples in `src-tauri/src/lib.rs`).

## README highlights

- Suggested editor: VS Code with Tauri extension and rust-analyzer.

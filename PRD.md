Yes, we can build this in Rust. It's a good fit: secure, performant, and cross-platform.

Recommended stack for basics + decent UI:

- **Language**: Rust
- **UI**: Tauri (Rust backend + web frontend with HTML/CSS/JS or a framework like Svelte/Vue/React). Use xterm.js for the terminal emulator.
- **SSH**: russh crate (pure-Rust async SSH client)
- **Storage**: Simple JSON file or rusqlite for snippets/connections
- **Why Tauri**: Lightweight desktop app, modern UI easy to style, great terminal integration via web tech, cross-platform binaries.

# PRD: Basic Rust SSH Terminal with Snippets

## 1. Overview

A cross-platform desktop app for SSH connections with saved snippets (commands/scripts) that can be executed on the remote server.

Goal: Minimal viable product (MVP) with clean UI, reliable connections, and snippet execution.

## 2. Core Features (MVP Scope)

- Add, edit, delete server connections (host, port, username, password/key)
- Connect/disconnect via SSH
- Interactive terminal (send commands, see output)
- Global snippets: save, list, edit, delete, execute on current connection
- Basic UI: connection list, terminal view, snippet sidebar/panel
- Auto-reconnect option (optional)
- Error handling and logging

## 3. Non-Functional Requirements

- Cross-platform: Windows, macOS, Linux
- Secure: no plaintext passwords in memory longer than needed
- Decent UI: modern look, responsive, dark/light theme support
- Performance: low latency terminal, async operations

## 4. Tech Stack

- Rust (backend, logic, SSH)
- Tauri v2 (app framework)
- russh (SSH client)
- xterm.js (terminal in frontend)
- serde + toml/json (config/snippet storage)
- Frontend: plain JS + Tailwind CSS (or Svelte for reactivity)

## 5. Atomic Task List

Track progress by checking boxes as tasks are completed.

### Phase 1: Project Setup

- [x] Create new Tauri project (`cargo create-tauri-app`)
- [x] Set up Rust workspace with `src-tauri` and frontend folders
- [x] Add dependencies: russh, tokio, serde, serde_json
- [x] Configure tauri.conf.json for window size, title, etc.
- [ ] Set up basic frontend (index.html with Tailwind or CSS framework)
- [ ] Test build and run (`cargo tauri dev`)

### Phase 2: Server Connection Management

- [ ] Define Rust structs: ServerConnection { host, port, user, auth (password/key) }
- [ ] Create UI form for adding/editing servers
- [ ] Store connections in a JSON/TOML file (load on startup, save on change)
- [ ] Expose Rust commands to frontend via Tauri's invoke system for CRUD on connections
- [ ] Display list of saved servers in UI sidebar

### Phase 3: SSH Connection & Terminal

- [ ] Implement async SSH connect function using russh (support password & key auth)
- [ ] Handle connection states: connecting, connected, disconnected, error
- [ ] Create channel for shell (PTY) using russh
- [ ] Expose Rust commands: connect, disconnect, send_input, resize
- [ ] Integrate xterm.js in frontend for terminal rendering
- [ ] Wire up: on connect, open terminal, forward input/output via Tauri events
- [ ] Implement disconnect and cleanup

### Phase 4: Snippet Management

- [ ] Define Snippet struct: { name, command (String), description? }
- [ ] UI panel/sidebar for snippets: list, add/edit/delete
- [ ] Store snippets in JSON/TOML (separate file or same as connections)
- [ ] Expose Rust commands: CRUD snippets
- [ ] Add "Run Snippet" button per snippet → send command to current SSH channel

### Phase 5: Polish & Error Handling

- [ ] Add status bar (connection state, host info)
- [ ] Handle SSH errors (auth fail, timeout, disconnect) with UI alerts
- [ ] Implement auto-scroll in terminal
- [ ] Add dark/light theme toggle (CSS variables)
- [ ] Basic keyboard shortcuts (Ctrl+C, etc.)
- [ ] Test on at least two platforms (e.g., Linux + Windows)

### Phase 6: Build & Distribution

- [ ] Configure tauri build for release (icons, bundle)
- [ ] Build installers: .exe, .dmg, .deb/.AppImage
- [ ] Test built app on target platforms

This is a realistic MVP task list. Start with Phase 1, then move sequentially. You can add features later (per-server snippets, tunneling, file transfer, etc.)

- [x] done task (skipped)

# AGENTS.md

This file provides guidelines for agentic coding assistants working on the ssh-thing repository.

## Project Overview

ssh-thing is a Tauri-based SSH client application. It uses:
- **Tauri 2.x** for the desktop app framework
- **Rust** for the backend (src-tauri/src/)
- **Vanilla HTML/JavaScript** for the frontend (frontend/)
- **russh** for SSH connections
- **tokio** for async runtime
- **serde** for serialization (JSON and TOML)

## Build Commands

### Development
```bash
npm run tauri dev      # Run in dev mode with hot reload (uses npm package)
cargo tauri dev        # Run in dev mode (uses cargo)
```

### Production Build
```bash
npm run tauri build    # Build production bundle
cargo tauri build      # Build production bundle
```

### Platform-Specific Builds
```bash
npm run tauri build -- --target x86_64-apple-darwin  # macOS
npm run tauri build -- --target x86_64-pc-windows-msvc  # Windows
npm run tauri build -- --target x86_64-unknown-linux-gnu  # Linux
```

### Rust Commands
```bash
cargo build                    # Debug build
cargo build --release          # Release build
cargo test                     # Run all tests
cargo test test_name           # Run single test by name
cargo test --lib               # Run lib tests only
cargo check                    # Check for errors without building
cargo clippy                   # Run linter
cargo fmt                      # Format code
```

## Code Style Guidelines

### Rust Conventions

**Formatting:**
- Use `cargo fmt` to format code automatically
- No custom rustfmt.toml exists; use defaults (4 spaces, rustfmt max width 100)
- Use rustfmt's default brace style and indentation
- Prefer self-documenting code. Add comments for non-obvious logic, security considerations, or complex algorithms.

**Naming:**
- `snake_case` for functions, variables, and module names
- `PascalCase` for structs, enums, and traits
- `SCREAMING_SNAKE_CASE` for constants
- Prefix unused variables with `_` (e.g., `_var`)

**Imports:**
- Group imports by crate: standard library first, then external crates
- Use `use` statements for frequently used items
- Avoid fully qualified paths when `use` suffices
- Example order: `std` → external crates → local modules

```rust
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
```

**Error Handling:**
- Use `Result<T, String>` for fallible functions that interact with the UI
- Propagate errors with `?` operator
- Use `.map_err(|e| format!("context: {}", e))` to add context
- Avoid `unwrap()` and `expect()` in production code
- Use `ok_or_else(|| "error message".to_string())` for Option to Result conversion

**Types:**
- Use `&str` for string slices, `String` for owned strings
- Use `u16` for ports, `u32` for dimensions
- Use `Arc<Mutex<T>>` for shared mutable state (see AppState pattern)
- Derive `Debug, Clone, Serialize, Deserialize` for data structures
- Use `#[serde(tag = "type")]` for tagged enums

**Async/Await:**
- Use `async`/`await` with tokio runtime
- Functions called from JavaScript must be marked `async` and return `Result`
- Use `tokio::sync::Mutex` for async locking (not std::sync::Mutex)
- Handle async errors by emitting connection-state events

**Testing:**
- Place unit tests in `#[cfg(test)] mod tests` within the same file
- Use `#[test]` attribute for test functions
- Use descriptive test names: `test_server_connection_serialization`
- Use `assert_eq!`, `assert!` for assertions
- Use `expect()` only in tests for clear failure messages

**Tauri-Specific:**
- Mark exported functions with `#[tauri::command]`
- Use `AppHandle` for app-level operations (events, paths, state)
- Use `app.emit("event-name", payload)` to send events to frontend
- Use `app.state::<AppState>()` to access managed state
- Commands receive `AppHandle` by value, not reference

### State Management Pattern

```rust
struct AppState {
    sessions: Mutex<HashMap<String, SshSession>>,
    shells: Mutex<HashMap<String, PtyShell>>,
}

// In run():
.manage(AppState {
    sessions: Mutex::new(HashMap::new()),
    shells: Mutex::new(HashMap::new()),
})
```

### Frontend Integration

- Frontend files are in `frontend/` (index.html, main.js)
- Frontend accesses Rust commands via `window.__TAURI__.invoke`
- Events from Rust use `app.emit()` and are received via `listen()` in JS

## Key Files

### Rust Backend
- `src-tauri/src/lib.rs` - Main application logic, commands, SSH handling
- `src-tauri/src/main.rs` - Entry point
- `src-tauri/build.rs` - Build script
- `src-tauri/src/actions.rs` - Actions CRUD + execution (563 lines)
- `src-tauri/src/osc52.rs` - OSC52 escape sequence parser + clipboard (309 lines)
- `src-tauri/capabilities/default.json` - Tauri 2.x permissions
- `src-tauri/tauri.conf.json` - Tauri configuration

### Frontend
- `frontend/index.html` - Main HTML
- `frontend/main.js` - Frontend JavaScript
- `frontend/components/session-manager.js` - Terminal sessions, xterm.js, tabs (830 lines)
- `frontend/components/actions-manager.js` - Actions UI CRUD + execution (493 lines)
- `frontend/components/server-list.js` - Server card rendering (196 lines)
- `frontend/components/about-modal.js` - About modal component (62 lines)
- `frontend/components/header-menu.js` - Header dropdown menu (40 lines)

## Dependencies

### Rust Crates
- **russh**: SSH client implementation
- **tokio**: Async runtime
- **serde/serde_json**: JSON serialization
- **toml**: TOML configuration files
- **uuid**: Generate unique IDs
- **tauri**: Desktop app framework
- **keyring**: System keychain credential storage

### Frontend
- **xterm.js**: Terminal emulator
- **xterm-addon-fit**: Terminal auto-resize
- **xterm-addon-search**: Terminal search

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **br (beads)** for issue tracking. Run `br prime` to see full workflow context and commands.

### Quick Reference

```bash
br ready              # Find available work
br show <id>          # View issue details
br update <id> --claim  # Claim work
br close <id>         # Complete work
```

### Rules

- Use `br` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `br prime` for detailed command reference and session close protocol
- Use `br remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   br dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->

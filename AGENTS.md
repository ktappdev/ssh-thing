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
- Do NOT add comments unless explicitly required

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

- `src-tauri/src/lib.rs` - Main application logic, commands, SSH handling
- `src-tauri/src/main.rs` - Entry point
- `src-tauri/build.rs` - Build script
- `src-tauri/tauri.conf.json` - Tauri configuration
- `frontend/index.html` - Main HTML
- `frontend/main.js` - Frontend JavaScript

## Dependencies

- russh: SSH client implementation
- tokio: Async runtime
- serde/serde_json: JSON serialization
- toml: TOML configuration files
- uuid: Generate unique IDs
- tauri: Desktop app framework

# SSH Thing

[![Version](https://img.shields.io/badge/version-1.1.21-blue.svg)](https://github.com/ktappdev/ssh-thing/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tauri 2.x](https://img.shields.io/badge/Tauri-2.x-orange.svg)](https://v2.tauri.app)
[![Rust](https://img.shields.io/badge/Rust-2021-yellow.svg)](https://www.rust-lang.org)

A cross-platform desktop SSH client built with **Tauri 2.x** (Rust backend) and vanilla HTML/JS. Lightweight, fast, and focused on what matters — connecting to servers.

![SSH Thing screenshot](./screen1.jpg)

## Why SSH Thing?

Most SSH clients try to do everything. SSH Thing does what you actually need:

- **Lightweight** — Small binary, minimal system overhead
- **Fast** — Instant startup, responsive terminal
- **Focused** — No bloat, just essential features
- **Secure** — Credentials stored in OS keychain, not plaintext

## Features

### SSH Core
- **Server Management** — Save servers with nicknames, hosts, ports, and auth methods
- **Password & Key Auth** — Support for both password and SSH key authentication
- **Host Key Verification** — TOFU model with known hosts persistence
- **One-Click Connect** — Connect/disconnect with a single click
- **Concurrent Sessions** — Run multiple SSH connections simultaneously

### Terminal
- **PTY Support** — Full pseudo-terminal with proper signal handling
- **OSC52 Clipboard** — Copy terminal output directly to system clipboard
- **Scrollback Buffer** — Configurable history size
- **Terminal Resize** — Adjust terminal dimensions on the fly
- **Search** — Find text in terminal output

### Productivity
- **Snippets** — Save and reuse commands across sessions
- **Actions** — Command macros with execution history and status tracking
- **Import/Export** — Backup and restore your servers, snippets, and actions
- **Connection Log** — Track your connection history

### Interface
- **Dark/Light Theme** — Toggle to match your preference
- **Focus Mode** — Hide sidebar for maximum terminal space
- **Global Shortcuts** — Quick access from anywhere in the app
- **Status Indicators** — Clear connection state feedback

## Download

### Pre-built Binaries

Get the latest release from the [Releases page](https://github.com/ktappdev/ssh-thing/releases).

### Platform-Specific Notes

#### macOS
1. Mount the `.dmg` and drag **SSH Thing** to Applications
2. If blocked by Gatekeeper, run:
   ```bash
   sudo xattr -cr "/Applications/SSH THING.app"
   ```
3. Or right-click → Open

#### Windows
1. Run the `.msi` installer
2. If SmartScreen blocks, click **More info** → **Run anyway**

#### Linux
1. Install the `.deb` or `.AppImage` from releases
2. For `.deb`:
   ```bash
   sudo dpkg -i ssh-thing_*.deb
   ```
3. For `.AppImage`:
   ```bash
   chmod +x ssh-thing_*.AppImage
   ./ssh-thing_*.AppImage
   ```

## Build from Source

### Prerequisites

- [Rust](https://www.rust-lang.org/) (2021 edition)
- [Node.js](https://nodejs.org/) (for npm)
- [Tauri 2.x prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
git clone https://github.com/ktappdev/ssh-thing.git
cd ssh-thing
npm install
npm run tauri dev
```

### Production Build

```bash
npm run tauri build
```

For macOS universal builds (Intel + Apple Silicon):

```bash
./build-release.sh
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Rust + Tauri 2.x |
| SSH | [russh](https://github.com/warp-tech/russh) (pure Rust) |
| Async | Tokio |
| Keychain | [keyring](https://github.com/hwchen/keyring.rs) |
| Frontend | Vanilla HTML/JS |

## Usage

### Add a Server

1. Click **+** in the Servers tab
2. Fill in details:
   - **Nickname** — Friendly name (e.g., "Production API")
   - **Host** — IP or hostname
   - **Port** — SSH port (default: 22)
   - **Username** — SSH user
   - **Auth** — Password or private key
3. Click **Save**

### Connect

1. Click a server in the list
2. Authenticate if prompted
3. Start typing commands

### Use Snippets

1. Open the **Snippets** tab
2. Add a command with title and description
3. Click any snippet to paste it into the active terminal

### Run Actions

1. Open the **Actions** tab
2. Create a macro (e.g., "Deploy" → `git pull && npm install && pm2 restart all`)
3. Execute on any connected server
4. View execution history and status

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + N` | New server |
| `Ctrl/Cmd + K` | Quick connect |
| `Ctrl/Cmd + L` | Clear terminal |
| `Ctrl/Cmd + F` | Search terminal |
| `Ctrl/Cmd + D` | Disconnect |
| `F11` | Focus mode toggle |

*Note: Shortcuts may vary by platform. Check the app menu for platform-specific shortcuts.*

## Contributing

Contributions welcome! Open an issue or submit a PR.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

## License

[MIT](LICENSE) © Ken Taylor

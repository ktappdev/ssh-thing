# SSH PRD Task List

This file is an atomic task list derived from the PRD for building a reliable SSH terminal + SFTP client.

## Decisions (locked)
- Known hosts format: JSON stored in app data dir (e.g., `known_hosts.json`) with fields `{ host, port, key_type, fingerprint, public_key_base64, added_at }`.
- Security posture: Encrypt secrets now using OS keychain (macOS Keychain via `tauri-plugin-store` + `tauri-plugin-keychain` or a thin native wrapper).
- Multi-session: not required now, but include shell/session IDs in all events to avoid breaking later.
- SFTP UI: separate pane or modal.

---

# Phase 0 — Terminal must work (core)

## Backend: SSH channel I/O correctness
- [x] Add structured logging around connect/auth, channel open, read loop start/stop, send_input calls (dev-only).
- [x] Refactor channel read loop to avoid lock re-entrancy:
  - [x] Introduce a dedicated read task that owns the channel receiver.
  - [x] Ensure the read loop never holds the channel lock while emitting events.
- [x] Ensure `terminal-output` events include `shell_id` in payload (future-proofing multi-session).
- [x] Ensure `send_input` routes to correct shell; return explicit error if shell not found.
- [x] Verify `disconnect` closes channel and removes shell from map.
- [ ] Add a backend-only smoke test for SSH session lifecycle (mocked or local test server if available).

## Backend: PTY/resize correctness
- [x] Verify PTY requests include correct terminal type and dimensions.
- [x] Ensure resize updates the existing PTY (no new channels).
- [x] Confirm resize does not deadlock with read loop (lock ordering).

## Frontend: Terminal I/O + lifecycle
- [x] Ensure `terminal-output` handler writes output to correct terminal instance (by shell_id).
- [x] Send initial “connected” info to UI, including server host/user.
- [x] Confirm keystroke handling and paste handling send bytes to `send_input`.
- [x] Ensure disconnect disables input, clears shell_id, and updates UI state.
- [x] Add a basic “connection log” section in UI (optional) to show errors from backend.


---

# Phase 1 — Host key verification (TOFU)

## Backend: Known hosts storage
- [x] Add `known_hosts.json` storage in app data dir.
- [x] Define `KnownHost` struct with:
  - `host`, `port`, `key_type`, `fingerprint`, `public_key_base64`, `added_at`
- [x] Implement load/save helpers for known hosts store.

## Backend: Host key verification flow
- [x] Modify `check_server_key` to:
  - [x] Look up existing known host by host:port.
  - [x] If exists and matches: return `Ok(true)`.
  - [x] If exists but mismatch: return `Ok(false)` and emit a “host-key-mismatch” event.
  - [x] If missing: emit a “host-key-prompt” event with fingerprint and wait for user decision.
- [x] Add a command `trust_host_key(host, port, public_key_base64, fingerprint)` that writes to known_hosts.
- [x] Add a command `reject_host_key(host, port)` that aborts the pending connection.

## Frontend: Host key prompt UI
- [x] Add modal prompting to trust new host key.
- [x] Display host/port + key type + fingerprint prominently.
- [x] On accept: call `trust_host_key` and retry connection.
- [x] On reject: call `reject_host_key` and show an error state.


---

# Phase 4 — Polish / future-proofing

## Multi-session readiness
- [x] Ensure every event includes `shell_id` (connection-state, terminal-output).
- [x] Update frontend state to key on `shell_id`.
- [ ] Add minimal groundwork for future tabs (no UI needed yet).

## Packaging improvements
- [ ] Replace CDN Tailwind with built CSS asset (Tailwind CLI + pnpm).
- [ ] Bundle xterm.js and CSS locally in `frontend/vendor/`.


---

# Phase 2 — Encrypted secrets (passwords/keys)

## Backend: Keychain integration
- [ ] Add tauri keychain plugin or minimal native keychain wrapper.
- [ ] Store server secrets (password/private key) in keychain, not in JSON.
- [ ] Replace `ServerConnection.auth` to hold a secret reference ID (keychain key).
- [ ] Migrate existing servers on load: if plaintext secrets exist, prompt to migrate.

## Frontend: Secrets workflow
- [ ] On save/update server: write secret to keychain, store reference ID only.
- [ ] On connect: request secret from keychain using reference ID.
- [ ] On delete: remove secret from keychain.

## Manual acceptance checks (Phase 2)
- [ ] Saving a server no longer writes secrets to JSON.
- [ ] Connection still succeeds with stored secrets.
- [ ] Removing a server removes its secret.

---

# Phase 3 — SFTP MVP (separate pane/modal)

## Backend: SFTP plumbing
- [ ] Add SFTP support (russh-sftp or equivalent).
- [ ] Expose commands:
  - [ ] `sftp_list_dir(shell_id, path)`
  - [ ] `sftp_download(shell_id, remote_path, local_path)`
  - [ ] `sftp_upload(shell_id, local_path, remote_path)`
  - [ ] `sftp_mkdir(shell_id, path)`
  - [ ] `sftp_remove(shell_id, path)`
- [ ] Emit progress events for upload/download with bytes transferred.

## Frontend: SFTP UI
- [ ] Add “Files” button to open SFTP pane/modal.
- [ ] List directory contents with name/size/modified.
- [ ] Add breadcrumbs or path input for navigation.
- [ ] Add Upload/Download buttons + progress.
- [ ] Handle errors and show in UI.

## Manual acceptance checks (Phase 3)
- [ ] Download file, checksum matches remote.
- [ ] Upload file, visible in remote listing.
- [ ] Large file transfer shows progress and can be canceled.


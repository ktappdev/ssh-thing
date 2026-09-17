# SSH Thing CLI for LLMs — Design Spec

**Status: implemented and committed; not yet released.** The CLI exists at
`crates/ssh-thing-cli` (binary `ssh-thing`), shares `crates/ssh-thing-core` with
the desktop app, and is gated by the desktop app's Automation panel. What has
not happened: no release carries a CLI binary yet, and no successful remote
command has been run through it.

Read `docs/STATE-OF-WORK.md` first for live state and gaps.
Engineering ground truth, including the implementation record:
`docs/CLI-KNOWLEDGE-BASE.md`.

## 1. Goal

Give LLMs and other automation a safe way to use SSH Thing without handing them
an interactive shell or arbitrary command execution.

The LLM may only:

1. List saved servers (metadata, never secrets).
2. List saved snippets (each scoped to a server).
3. Run one saved snippet against the server it is scoped to.
4. Read back bounded stdout/stderr, exit code, and timing.

The LLM may never:

- Supply its own command string.
- Supply its own host, user, port, password, or private key.
- Create, edit, or delete servers or snippets.
- Open an interactive shell or PTY session.
- Approve host keys, change automation settings, or disable guardrails.

Mental model: **capabilities, not shell access**. The human curates a menu of
approved server-plus-command pairs in the desktop app; the LLM can only order
from that menu.

## 2. Non-goals for v1

- No interactive `ssh` replacement.
- No file transfer (`scp`/`sftp`).
- No port forwarding or tunnels.
- No jump-host chaining beyond what the saved server already defines.
- No snippet editing from the CLI.
- Passphrase-protected private keys. The stored key must be unencrypted; the
  desktop app and the CLI both pass no passphrase to `decode_secret_key`, so a
  protected key fails identically in both.
- No Windows install flow (the CLI compiles on Windows but is not published).

## 3. Shipped surface

```text
ssh-thing servers [--json|--human]
ssh-thing snippets [--server <id|label>] [--json|--human]
ssh-thing run --snippet <id|name> [--server <id|label>] [--timeout <seconds>] [--dry-run] [--json|--human]
ssh-thing history [--limit <n>] [--json|--human]
ssh-thing doctor [--json|--human]
ssh-thing version [--json|--human]
```

`--json` is the default and is the stable contract. `--human` exists for a
person reading a terminal; it is not a second contract.

### Response envelope

Every command prints one object, on stdout, whether it succeeded or not —
including argument errors such as an unknown subcommand, a missing flag, or an
invalid value. stdout is never empty, so a caller always has something to parse:

```json
{
  "ok": true,
  "command": "run",
  "error": null,
  "data": { }
}
```

On failure `ok` is `false` and `error` carries `code`, `message`, and an
optional `hint`:

```json
{
  "ok": false,
  "command": "run",
  "error": {
    "code": "automation_disabled",
    "message": "External automation is turned off, so the CLI will not run anything.",
    "hint": "Open SSH THING, use the header menu, and enable 'Allow external automation' in the Automation section."
  },
  "data": null
}
```

A run that executed and failed sets `ok: false` **and** still populates `data`
with the full report, so the caller can read the output, exit code, and error
while branching on `ok`. Error codes in use: `usage`, `read_failed`,
`app_data_dir`, `automation_disabled`, `settings_unreadable`, `not_scoped`,
`scope_mismatch`, `server_missing`, `run_failed`, `clock_error`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including `--dry-run`). |
| 1 | Usage: unknown or ambiguous snippet/server, bad selector, or an argument error (unknown subcommand, missing or invalid flag). Never exits 2 and never leaves stdout empty. |
| 2 | The run executed and failed (non-zero exit, timeout, connect, auth). |
| 3 | Blocked by policy before running: gate off, unscoped snippet, cross-server. |

### Example `run` data

```json
{
  "snippet_id": "8f4c…",
  "snippet": "restart-api",
  "server_id": "1b2c…",
  "server": "prod-api",
  "command": "sudo systemctl restart api",
  "status": "success",
  "exit_code": 0,
  "duration_ms": 2314,
  "timeout_seconds": 60,
  "timeout_clamped": false,
  "output_truncated": false,
  "output": "…bounded stdout/stderr…",
  "error": null,
  "dry_run": false
}
```

### Behaviour notes

- Selectors accept an id (exact) or a label/name (case-insensitive, must be
  unique). Ambiguity is an error listing the candidate ids.
- `run` resolves the snippet first, then requires the snippet's `server_id`.
  A legacy global snippet is never runnable from the CLI.
- `--server` is optional. When supplied it must equal the snippet's own scope;
  cross-server execution is refused with `scope_mismatch`.
- `--server` is never used to *pick* a server for an unscoped snippet.
- Timeout defaults to 60s and is clamped to 5–600s; `timeout_clamped` reports
  when the requested value was adjusted. The clamp lives in
  `core::ssh::clamp_timeout` and is the same one `exec_command` applies, so the
  CLI and the desktop Actions editor (`min="5"`, `max="600"`) cannot disagree.
- A command killed by the timeout comes back with an error that names the cause:
  the CLI allocates no PTY, so a command waiting on a password prompt can only
  hang until the timeout. Snippets intended for CLI use should rely on
  `NOPASSWD` sudo or key authentication.
- An unreadable `settings.json` is a policy refusal, not a run failure: it
  exits 3 with `settings_unreadable` and a hint, rather than being silently
  defaulted or reported as `run_failed`.
- `doctor` separates `healthy` (every check except the gate passed) from
  `runnable` (`healthy` **and** the automation gate is on). Agents should branch
  on `runnable`; `healthy` stays true with automation off so a clean install
  still reads as a clean install.
- Output is capped at 64 KiB (one shared constant with the desktop action
  runner) and the cap appends `[output truncated]` once, with
  `output_truncated: true`.
- No PTY is allocated for CLI runs. Rationale in §4.
- Command execution requires an exit status; a command that produces neither
  output nor an exit status is reported as an error rather than a silent success.

## 4. Deliberate deltas from the first draft of this spec

These changed during implementation. Each has a reason.

| Spec said | Shipped | Why |
|---|---|---|
| Flat JSON for `run` | Uniform `{ok, command, error, data}` envelope | One shape for every command and every outcome is a smaller contract for a model to hold. The flat example also had no way to report a pre-flight refusal. |
| CLI history shares `action-history.json` | Separate `cli-history.json` (cap 500) | The shapes differ (snippets vs actions) and mixing them would surface CLI runs inside the desktop Actions history list. |
| CLI output cap "matching the desktop action runner" | One shared `MAX_OUTPUT_BYTES` in core | Now literally the same constant, not two copies that drift. |
| `run` may require both `--server` and `--snippet` | `--snippet` required, `--server` optional-but-validated | The snippet is the capability. Requiring a redundant server argument adds no safety and one more way for a caller to fail. |
| PTY for command execution | Desktop allocates a PTY, CLI does not | The CLI has no stdin, so a PTY cannot help a prompt — it only hangs until timeout. Without a PTY the output is clean and parseable. Consequence: commands needing a password prompt must use `NOPASSWD` sudo. |
| Asset names `ssh-thing-cli_<version>_<platform>` | `ssh-thing_<version>_<platform>` | Matches the installed binary name. The installer and the workflow share one naming rule. |
| Installer may offer `/usr/local/bin` with elevation | `~/.local/bin` only | Elevation from a GUI app with no TTY means a password prompt we cannot service. A user-owned path needs no privilege and no capability change. |
| `--json` default with human fallback | Same, plus an explicit `--human` | A flag beats guessing from TTY state, which is unreliable inside agents. |

## 5. Distribution: the desktop app installs the CLI on demand

The desktop app remains the primary install. The CLI is **not** bundled or
installed automatically.

The Automation panel (header menu → Automation) does:

1. Detect OS and CPU architecture: `macos-aarch64`, `macos-x64`, `linux-x64`.
2. Download `<repo>/releases/download/v<version>/ssh-thing_<version>_<platform>`.
3. Download the sibling `.sha256` **first**, and refuse to keep bytes that do
   not match. A mismatch deletes the staged file and installs nothing.
4. Stage to `~/.local/bin/.ssh-thing.download`, `chmod 0o755`, then `rename`
   into place, so a partial download can never be executed.
5. On macOS, run `/usr/bin/xattr -dr com.apple.quarantine` defensively.
6. Run `ssh-thing version` as a smoke test. If the binary cannot start — wrong
   architecture, truncated file — the install is reported as not usable instead
   of as success.
7. Record path and version, then report status. If `~/.local/bin` is not on
   `PATH`, show the exact `export PATH=...` line and stop there. The app never
   edits shell rc files.

Installing the CLI does **not** enable automation. The toggle is a separate
action (§7).

Uninstall removes the binary and clears the recorded path; it leaves the
automation setting alone.

## 6. Security model

| Rule | Rationale |
|---|---|
| No `--command`, `--host`, `--user`, `--password`, `--key` flags | The CLI cannot become a generic SSH client. |
| No create/update/delete commands | Curation stays in the desktop UI where the human reviews it. |
| Secrets never appear in output, logs, errors, or history | Keyring values are read only for the auth handshake. `servers` exposes the *name* of an override variable, never a value. |
| Fail closed on unknown host keys | Verified: a run against an unknown host is refused and `known_hosts.json` is left byte-identical. The CLI never learns a key. |
| Host key mismatch is refused with both fingerprints | Same remedy as the desktop: re-approve in the app. |
| Snippet must be scoped to the server it runs on | The snippet *is* the capability. Cross-server is refused. |
| Bounded output + timeout on every run | Prevents hangs and context-window flooding. |
| Append-only local run log | Every CLI run, including dry runs, lands in `cli-history.json`. |
| Automation toggle gates runs | Default off. Off means `run` exits 3 with an actionable hint. |
| No PTY, no stdin | A run cannot be driven interactively. |
| Secrets can come from the environment when the keychain is unreachable | `SSH_THING_SECRET_<SANITIZED_ID>`, opt-in by nature, nothing written to disk. |

## 7. Guardrails owned by the desktop app

- **Allow external automation** — master switch, default **off**. When off, the
  CLI can list metadata but every `run` exits 3.
- **CLI install state** — installed version, path, update availability, and
  Install/Update/Reinstall/Uninstall actions.
- **Snippet scope** — the snippet modal assigns `server_id`. New snippets are
  unscoped by default and therefore CLI-unrunnable until assigned.
- **Per-snippet destructive approval** — deliberately not in v1 (decision D5).

## 8. Data and compatibility

- `Snippet` gains `server_id: Option<String>`, `#[serde(default)]`, so old files
  load with `None` (global, desktop-only).
- `known_hosts.json`, `servers.json`, `snippets.json`, `actions.json`,
  `action-history.json` are read by both binaries from the same directory.
- `settings.json` is new: `allow_external_automation`, `cli_install_path`,
  `cli_installed_version`, `app_version`. Missing or partial files load as
  defaults; a corrupt file fails closed.
- The CLI never migrates data. It reads legacy inline `Password`/`Key` auth
  variants directly and leaves migration to the desktop app, which owns keychain
  writes.
- `SSH_THING_DATA_DIR` relocates the data directory. Intended for tests,
  fixtures, and separate profiles; it exposes no credential surface.
- New fields are always `Option` or `#[serde(default)]`; `DATA_SCHEMA_VERSION`
  is `1` and is reported by `ssh-thing version`.

## 9. Release and CI

- `release.yml` gained a `build-cli` job: `macos-aarch64`, `macos-x64`,
  `linux-x64`, each running `cargo build --release -p ssh-thing-cli --target …`,
  then `sha256sum`/`shasum -a 256` into `<asset>.sha256`.
- Assets attach to the same GitHub Release as the desktop bundles, via the same
  `softprops/action-gh-release@v2` step, pinned at v2.
- `update-homebrew` now needs `[build, build-cli]`, so the cask only moves once
  the whole release — desktop bundles and CLI assets — is uploaded.
- The CLI job installs no GTK/webkit dependencies; it is a plain Rust build.

## 10. Decisions (all resolved)

| # | Decision | Outcome |
|---|---|---|
| D1 | Remove Actions? | **Still open.** Not required for the CLI. Actions is deprecated in docs and untouched in code. |
| D2 | Headless keyring | Environment override only: `SSH_THING_SECRET_<SANITIZED_ID>`. Blank values ignored. No file store. `doctor` lists the variable name per server. |
| D3 | Install target + PATH | `~/.local/bin`. No elevation, no rc-file edits, printed hint only. |
| D4 | `run` flag shape | `--snippet` required; `--server` optional and validated against the snippet's scope. |
| D5 | Destructive approval | Not in v1. The master toggle is the gate. |
| D6 | Download source | GitHub Releases, with published `.sha256`. R2 remains a possible future mirror. |
| D7 | Homebrew cask gated on the CLI build | **Keep the gate.** `update-homebrew` still needs `[build, build-cli]`, so the cask moves only when the release is complete. A CLI build failure therefore delays the Homebrew update but never publishes a partial release; the DMGs and the GitHub Release are unaffected. |

## 11. Remaining gaps

Everything architectural is closed; see `docs/CLI-KNOWLEDGE-BASE.md` §6 for the
list of what implementation could not verify (no release carries CLI assets yet,
no successful remote run, GUI never clicked). Those are evidence gaps, not
design unknowns — the next release and one dogfooding session close them.

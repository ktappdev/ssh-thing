# CLI Knowledge Base: Core Extraction, Evidence, Implementation Record

Companion to `docs/CLI-FOR-LLMS.md` (the product spec). This file is the
engineering ground truth: where coupling lives and how it was removed, what was
verified by running things, and exactly what the implementation does not cover.

Live project state and open decisions: **`docs/STATE-OF-WORK.md`** (read that
first if you are picking this up cold).

## 1. How the coupling was removed

The pre-refactor survey found every `AppHandle` touchpoint in
`src-tauri/src/lib.rs`. After the extraction, this is the actual shape:

| Concern | Before | After |
|---|---|---|
| Storage paths | `get_app_dir(&AppHandle)` everywhere | Desktop keeps a thin `get_app_dir`; core computes the same directory from the bundle identifier with `dirs` |
| Data types | Defined in `lib.rs` / `actions.rs` | All in `ssh-thing-core::model`, re-exported by `lib.rs` so call sites stayed short |
| Store load/save | Local functions taking `&Path` | `ssh-thing-core::store`, still `&Path`-pure |
| Keyring | `put_secret(_app: &AppHandle, …)` — the `AppHandle` was already unused | `ssh-thing_core::{put_secret,get_secret,delete_secret}` with no app parameter |
| Legacy auth migration | `migrate_server_auth(&AppHandle, &mut ServerConnection)` | `core::store::migrate_server_auth(&mut ServerConnection)`; `load_servers_migrated` does load → migrate → save |
| Connect + authenticate | ~200 lines inline in `connect_ssh`, bespoke per auth kind | `core::ssh::connect<H: Handler>(handler, …)` — generic over the handler, so the *policy* differs and the *mechanics* do not |
| Command execution | `collect_command_output` + `push_output` inside `actions.rs` | `core::ssh::exec_command(session, command, pty: Option<(u32,u32)>, timeout)` returning `CommandOutcome` |
| Disconnect | Inline `timeout(2s, …)` | `core::ssh::disconnect_quiet(session)` |
| Host-key policy | Only the interactive desktop handler existed | `core::ssh::StrictHostKeyHandler` fails closed; the desktop handler still prompts |
| Emits | Woven through connect/exec | Desktop wrappers emit; core returns `Err` or a callback-free outcome |

The desktop's `SshClientHandler` stayed in `lib.rs` on purpose: it owns
`AppState.pending_host_keys`, the oneshot decision channel, and the
`host-key-prompt` / `host-key-mismatch` emits. Core must not know about any of
that, so the desktop builds the handler and hands it to `core::ssh::connect`.

`open_pty_shell` and `osc52.rs` were left alone. They are desktop-only and have
no place in a CLI.

## 2. Layout as built

```text
Cargo.toml                      [workspace] members: src-tauri, crates/*
                                [workspace.package] version = "1.1.33"  <- release script bumps this

crates/ssh-thing-core/          no tauri dependency
  src/model.rs                  every on-disk shape + limits + DATA_SCHEMA_VERSION
  src/paths.rs                  app_data_dir(), home_dir(), SSH_THING_DATA_DIR override
  src/store.rs                  lenient JSON load/save for servers, snippets, actions,
                                action history, cli history, known hosts, settings
  src/secrets.rs                keyring + SSH_THING_SECRET_* override + probe()
  src/settings.rs               AutomationSettings
  src/ssh.rs                    connect, authenticate, StrictHostKeyHandler,
                                exec_command, output cap, disconnect_quiet

crates/ssh-thing-cli/           [[bin]] name = "ssh-thing"
  src/main.rs                   clap surface, dispatch, exit codes
  src/commands.rs               the six commands
  src/output.rs                 the response envelope

src-tauri/
  src/lib.rs                    thin Tauri command wrappers + interactive host-key handler
  src/actions.rs                actions CRUD + execution via core
  src/cli_manager.rs            cli_status / install_cli / uninstall_cli
  frontend/components/automation-manager.js
```

Because the version lives in `[workspace.package]`, `scripts/release-tag.sh`
bumps all three crates at once — no change to the release script was needed.

## 3. Live data shapes (verified 2026-09-16)

- `servers.json`: 5 servers, `SecretRef` auth confirmed live.
- `snippets.json`: 14 snippets, keys `{id, name, command, description}` — **zero
  have `server_id`**, so the CLI currently reports `0 runnable of 14 total`.
- `known_hosts.json`: 10 approved keys.
- `action-history.json`: 0 entries.
- `settings.json`: did not exist before this work; created on first app launch.
- `snippets.toml`: still present, still unreferenced (see §4b).

## 4. Confirmed findings

### 4a. `fs:default` is read-only — the installer had to be a Rust command

`src-tauri/gen/schemas/acl-manifests.json` → `fs.default_permission.permissions`
is exactly `["create-app-specific-dirs", "read-app-specific-dirs-recursive",
"deny-default"]`. There is **no write permission in the grant**.
`capabilities/default.json` adds nothing further.

Consequence, now implemented: `cli_manager.rs` is a set of Tauri commands, which
bypass the capability ACL entirely. No capability file was changed, and
`tauri-plugin-shell` was not added — the only external binary invoked is
`/usr/bin/xattr`, on macOS only, from Rust.

### 4b. `snippets.toml` is dead legacy

No source file references it; the `toml` crate had zero `toml::` usages. History:
`9a0d492` added TOML, `f2f61ad` moved snippets to JSON. **The `toml` dependency
has now been dropped** from `src-tauri/Cargo.toml`. The stale file in the app
data directory is harmless; the CLI ignores it.

### 4c. Keyring backends are pinned and can degrade silently

`keyring 2.3.3` with both Linux backends as non-optional lock dependencies. The
default on Linux is `secret-service`. If a build ever ends up with no platform
feature, the crate silently uses a **mock** store: everything appears to work and
secrets vanish. Mitigation shipped: `ssh-thing doctor` performs a write → read →
delete round trip on a throwaway entry and reports failure loudly.

### 4d. macOS denies keychain reads outside a GUI login session

Verified: works from a local terminal in the logged-in GUI session; fails from
SSH with `errSecInteractionNotAllowed (-25308)`. Shipped mitigation: the error
message names the variable to set, and
`SSH_THING_SECRET_<SANITIZED_SECRET_ID>` is checked before the keychain.
`doctor` prints the exact variable name for every server. Nothing is written to
disk in plaintext.

### 4e. reqwest is rustls by default in 0.13

`reqwest 0.13`'s `default-tls` feature resolves to `rustls` (not native-tls), so
`reqwest = "0.13"` needs no OpenSSL on Linux CI and pulls no system TLS library.
The lock file already contained `reqwest 0.13.2`, `sha2 0.10.9`, and `hex 0.4.3`
as transitive dependencies of Tauri, so the installer added no new download
outside `dirs` and `clap`.

### 4f. Tauri sidecars are not installers

`bundle.externalBin` + triple-suffixed `binaries/` run bundled helpers; they do
not place anything on `PATH`. The install flow therefore had to be a Rust
command, which §4a independently forces.

## 5. Implementation record

### Commands and exit codes

`servers`, `snippets [--server]`, `run --snippet [--server] [--timeout]
[--dry-run]`, `history [--limit]`, `doctor`, `version`; global `--json`
(default) / `--human`. Exit codes 0/1/2/3 as documented in the spec §3.

### Gates, in evaluation order for `run`

1. `settings.json` → `allow_external_automation` must be true, else exit 3.
   If the file cannot be parsed at all, this step refuses with
   `settings_unreadable` rather than falling back to a default.
2. Resolve the snippet by id-then-unique-name, else exit 1.
3. The snippet must carry a `server_id`, else exit 3 (`not_scoped`).
4. If `--server` was supplied it must match that `server_id`, else exit 3
   (`scope_mismatch`).
5. The referenced server must still exist, else exit 3 (`server_missing`).
6. Connect with fail-closed host keys, execute without a PTY, disconnect.
7. Append to `cli-history.json` — including dry runs, which are recorded with
   `status: "dry_run"`.

### Verification performed

```bash
node --check frontend/main.js
node --check frontend/components/automation-manager.js
cargo fmt --all --check
cargo test --workspace                                   # 99 passed
cargo clippy --workspace --all-targets -- -D warnings     # clean
cargo build -p tauri-app                                  # links
cargo build --release -p ssh-thing-cli                    # 3.99 MB
```

Test distribution: 42 in `tauri-app` (pre-existing suite, unchanged and still
passing against core types), 30 in `ssh-thing-core`, 8 unit + 19 integration in
`ssh-thing-cli`.

`crates/ssh-thing-cli/tests/cli.rs` invokes the compiled binary through
`env!("CARGO_BIN_EXE_ssh-thing")` with `SSH_THING_DATA_DIR` pointed at a
throwaway fixture directory. It covers the gate, scope validation, dry runs,
timeout clamping, selector resolution, history, and the guarantee that
`servers` output contains no credential material — all without a network.

End-to-end CLI checks against a fixture directory
(`SSH_THING_DATA_DIR=/tmp/ssh-thing-fixture`, two fake servers, three snippets):

| Case | Observed |
|---|---|
| Gate off | exit 3, `automation_disabled`, with the panel hint |
| Unscoped snippet | exit 3, `not_scoped` |
| `--server` pointing elsewhere | exit 3, `scope_mismatch` |
| `--dry-run` | exit 0, resolved server and command, nothing connected |
| Unknown snippet | exit 1, `usage`, with a `snippets` hint |
| Refused TCP connect | exit 2, `ok:false` **with** the full report in `data` |
| Unknown host key (`github.com:22`) | exit 2, "Unknown host key for github.com:22 … refusing to connect"; `known_hosts.json` still `[]` |
| `history` | three entries recorded, newest first |

That last row is the important one: the fail-closed policy was tested against a
real SSH server and the store was provably not written to.

Also verified structurally: `frontend/index.html` parses with balanced tags, no
duplicate ids, and every id `automation-manager.js` looks up exists.

### Known-unverified

- **No successful remote execution through the CLI.** No reachable
  non-production host was available, and the author deliberately did not point
  the CLI at the user's real servers. The exec path is shared with desktop
  Actions, so the risk is bounded, but it is unproven.
- **The installer has never fetched a real asset.** No release contains CLI
  binaries until the workflow runs once. Expect `cli_status` to report an update
  as available and `install_cli` to fail with a 404 until then.
- **The Automation panel has never been opened by a human.** Static checks only.
- Windows: the CLI compiles, but there is no published artifact and
  `set_executable` returns an explicit "not supported in this build" error.

### Bug found and fixed while working here

`frontend/main.js` invoked `upsert_secret` with `{ secret_id: … }`, but Tauri
maps the Rust parameter `secret_id` to the IPC key `secretId`. The argument was
therefore always absent and `Option<String>` resolved to `None`, so every
password/key save generated a **new** keychain entry and orphaned the previous
one. Fixed at both call sites. It was the only snake_case/camelCase mismatch in
the frontend; all other multi-word arguments already used camelCase.

### Hardening pass (post-review)

Six defects were found by reviewing the finished implementation against the
spec, and fixed. None of them changed the design; each removed a way the code
could disagree with its own documentation or hand a caller a wrong answer.

| # | Defect | Fix |
|---|---|---|
| 1 | **Two timeout clamps disagreed.** `commands.rs` clamped 5–600 inline; `core::ssh::clamp_timeout` clamped 1–600 and was exported but never called. | `clamp_timeout` is now the single rule (5–600, using the model constants) and `exec_command` applies it too. The CLI's inline clamp and its now-unused constant imports were deleted. The 5s floor matches the desktop Actions input (`min="5"`), so no desktop behaviour changed. |
| 2 | **Wrong doc comment.** `store::load_cli_history` claimed to return newest-first; it returns written order and `commands::history` reverses it. | Comment corrected; code untouched. |
| 3 | **A corrupt `settings.json` exited 2 as `read_failed`.** The gate file is policy, not run state, and a silent default would have hidden a broken gate. | Exits 3 as `settings_unreadable` with a `doctor` hint. `doctor` also gained a `settings_load` check so the condition is visible without attempting a run. |
| 4 | **`cli_status.update_available` was true with nothing installed,** because `None != Some(v)`. The UI masked it; API consumers did not. | `needs_update(installed, installed_version, expected)` — false when not installed, true when installed but stale *or* unreadable. Unit-tested exhaustively. |
| 5 | **`doctor` read `servers.json` twice** to build the check and the override-variable list, so the two could disagree. | Loaded once and reused. |
| 6 | **The checksum parser took the first whitespace token,** which only works for GNU `sha256sum` output. A BSD `SHA256 (file) = <hash>` file would have been rejected as malformed. | `parse_checksum` scans tokens for the first 64-hex value instead. Both formats unit-tested. |
| 7 | **Argument errors broke the contract.** clap printed to stderr and exited 2, which the spec reserves for "the run executed and failed", leaving stdout empty so a caller had nothing to parse. Found by *running* the binary, not by reading it — every one of cases 1–6 came from reading. | `Cli::try_parse()` is handled in `main.rs`: argument errors now emit the standard envelope with code `usage` and exit 1, `--help`/`--version` still print to stdout and exit 0, and `--human` is honoured from argv (parsing has already failed) so a person still gets prose on stderr. |

Two smaller additions came out of the same pass:

- **`doctor.runnable`** = `healthy && automation_enabled`. `healthy` deliberately
excludes the gate, so an agent previously needed two fields and a conjunction to
answer "will `run` work". Now it needs one.
- **Actionable timeout errors.** A timeout in the CLI now appends the reason: no
PTY is allocated, so a password-prompting command can only hang. The hint is
added in `commands.rs`, not in `core::ssh::exec_command`, so the desktop's
timeout text (which *does* allocate a PTY) is unchanged.

Verified after the pass: `cargo fmt --all --check`, 92 tests, `clippy -D warnings`
clean, both binaries build, and three behaviours checked by hand against the
release binary with a fixture data directory — `--timeout 1` reports
`timeout_seconds: 5` with `timeout_clamped: true`; `settings.json` containing
`null` exits 3 with `settings_unreadable`; `doctor --human` prints
`Runnable now: no` with the gate off while every other check passes.

### First run against the real data directory

The CLI was then exercised against the live app-data directory with read-only
commands, no snippet executed: `version`, `servers`, `snippets`, `history`, and
`doctor` all exit 0 and carry no credential material; the gate is off so every
`run` exits 3 `automation_disabled` before any connection; `snippets --server
<nonsense>` exits 1 `usage`. Live data at the time: 5 servers, 15 snippets, **0
scoped**, so `doctor` reported `snippets_load: 0 runnable of 15 total` with
`healthy: true` and `runnable: false` — exactly the distinction `runnable` was
added for. This run is what surfaced defect 7.

### Failure handling and fallbacks (2026-09-17)

Prompted by "handle it gracefully" rather than by a defect report: live failures
were flat. A refused connection, a bad hostname, an unpaid/powered-off server,
and an unroutable address all came back as `run_failed` plus raw OS text like
`Connection refused (os error 61)`. That is technically feedback and useless to
anyone who does not already read errno.

What changed:

| Change | Where |
|---|---|
| `classify_run_failure` maps a message to a specific `code` and an actionable `hint` | `core::ssh`, next to the messages it matches |
| `run` puts that code and hint in the envelope instead of a fixed `run_failed`, and `--human` prints the hint too | `cli/main.rs` |
| Repo-wide decision: a hint is never empty, including the catch-all | `classify_run_failure` |
| A 404 on install now says the version has no published asset yet and gives the from-source command; timeouts and connect failures get their own wording | `cli_manager::describe_download_error`, `not_published_message` |
| A scoped snippet that cannot get a session says `Snippet not run: …` instead of returning silently | `frontend/main.js`, `executeSnippet` |
| `execute_action` rejecting before any event clears the row's running state and shows the error instead of leaving it spinning | `frontend/components/actions-manager.js` |

Codes now in use for a failed run: `command_failed`, `command_timed_out`,
`command_signalled`, `unreachable`, `dns_failed`, `connect_timeout`,
`auth_failed`, `credential_missing`, `credential_unavailable`,
`host_key_unknown`, `host_key_mismatch`, `run_failed`. The ordering inside the
classifier is load-bearing: `Command timed out` is tested before the generic
`timed out`, or every command timeout would be reported as a connect timeout.

Verified live against `server2`, not only in fixtures:

| Failure | Result |
|---|---|
| `ls /definitely-not-here-xyz` | exit 2, `command_failed`, `exit_code: 2`, stderr in `data.output` |
| `sleep 12` with `--timeout 5` | exit 2, `command_timed_out`, `exit_code: null`, hint names the missing PTY |
| `127.0.0.1:1` | exit 2, `unreachable` |
| `nonexistent-host.invalid` | exit 2, `dns_failed` |
| unroutable address, 5s connect timeout | exit 2, `connect_timeout` |

Also confirmed: failed runs are written to `cli-history.json` with their error
text, so a failure leaves an audit trail rather than vanishing.

Two of the frontend fixes are the same class of bug as the CLI one — the user
was doing something and nothing happened. Neither had a test to catch it, and
this repository has no JS test harness, so both were reviewed by reading the call
path rather than by running it.

## 6. Remaining gaps

Nothing here is a design unknown; every item is closed by running the thing.

1. First release carrying `ssh-thing_<version>_<platform>` + `.sha256` assets.
   Only then does `install_cli` have anything to fetch.
2. One successful CLI run against a real server.
3. One pass through the Automation panel: toggle, install, uninstall.
4. D1 — whether Actions is removed (a product call, not engineering).

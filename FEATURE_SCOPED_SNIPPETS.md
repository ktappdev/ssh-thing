# Scoped Snippets Implementation Record

Status: **implemented, uncommitted, not yet run in the app.**
See `docs/STATE-OF-WORK.md` for the current working-tree state and open
decisions (including whether Actions gets removed).

## What this feature is

Snippets were global: a saved command you click to paste into whatever
terminal happens to be active. They are now **server-scoped**: a snippet can
be bound to one saved server, and clicking Run connects to that server first
(if it is not already connected) and then runs the command there.

This was Ken's direction, and it is the reason the CLI design in
`docs/CLI-FOR-LLMS.md` assumes `server_id`. It also deliberately overlaps
with the older Actions feature — see "Unresolved" below.

## Data model

`Snippet` in `crates/ssh-thing-core/src/model.rs` gains one field (it lived in
`src-tauri/src/lib.rs` at the time of the original diff; the types have since
moved into the shared core crate, and `src-tauri/src/lib.rs` re-exports them):

```rust
/// Server this snippet is scoped to. `None` is a legacy global snippet
/// that runs in whatever session is active.
#[serde(default)]
pub server_id: Option<String>,
```

`#[serde(default)]` is load-bearing: every existing `snippets.json` on disk
lacks the field and must still deserialize. Verified against live data — 14
snippets, **zero** currently scoped, all keys `{id, name, command, description}`.

No storage migration is needed. Scoping is per-snippet, assigned in the modal.

## Execution design (and why it is not the Actions path)

There were two candidate implementations:

| Approach | What the user sees | Verdict |
|---|---|---|
| **A. Reuse `execute_action` / one-shot runner** | Nothing in the terminal. Output captured headlessly into `action-history.json`, bounded to 64 KiB. | Rejected |
| **B. Reuse the live PTY session and `send_input`** | The command visibly types and runs in a real terminal, with scrollback, sudo prompts, and interactivity intact. | **Chosen** |

Rationale for B: snippets are a terminal affordance, not a background job.
A snippet that needs a sudo password prompt or a pager still works under B
and silently hangs under A. B also keeps the existing "click snippet → it
runs in the terminal" mental model. The cost is that output is not captured
or bounded, which is correct for a human-facing feature.

So execution is: **resolve server → ensure a live session → `send_input`
the stored command + `\n`.**

### Where the headless path came back

The CLI (`crates/ssh-thing-cli`) is the case approach A was rejected for: it has
no terminal and no human to answer a prompt, so it runs the command as a one-shot
exec with captured, bounded output via `core::ssh::exec_command`. The two paths
coexist on purpose — same stored snippet, two legitimate consumers:

| Consumer | Path | Output |
|---|---|---|
| Desktop, human | Live PTY, `send_input` | Visible, unbounded, interactive |
| CLI, agent | One-shot exec, no PTY | Captured, 64 KiB cap, no stdin |

## Changes by file

### `src-tauri/src/lib.rs`

- `Snippet.server_id: Option<String>` with `#[serde(default)]`.
- Test updates: `test_snippet_serialization` and
  `test_snippet_without_description` now set and assert `server_id`.
- New test `test_legacy_snippet_without_server_id_deserializes` — parses raw
  JSON with no `server_id` key and asserts `None`, guarding the upgrade path.

### `frontend/components/session-manager.js`

- `connectSession()` now **returns** the session on success and `null` on
  refusal or failure. Three return sites added/changed: session-limit guard
  (`return null`), error path (`return null`), and `return session` at the
  end. Previously returned `undefined` implicitly.
- `connectToServer(serverId, { refreshServers = true })` now returns
  `session | null` instead of nothing, and forwards the option.
- **New** `ensureConnectedSessionForServer(serverId)` — the scoped-snippet
  entry point. Reuses the most recent *live* session for that server (and
  focuses it); otherwise calls `connectToServer`. Exported from the manager.

Reuse-over-reconnect is deliberate: clicking five snippets bound to one host
should not open five tabs.

### `frontend/main.js`

- **New** `getSnippetServerLabel(serverId)` — display string. Returns
  `"Global · runs in active session"` for null, `"Missing server · reassign
  before running"` when the ID no longer resolves, else nickname or
  `user@host:port`.
- **New** `buildSnippetServerOptions(selectedServerId)` — option list for the
  modal, first entry is the empty "No server · runs in active session".
- **New** `syncSnippetServerSelect()` — repopulates the select only while the
  modal is open, preserving the current value (so a server rename mid-edit
  does not clobber the selection).
- **New** `sendSnippetToSession(session, snippet)` — writes the banner line,
  toggles the card's `status-connected` class, toasts, and `send_input`s.
  Extracted so both the scoped and legacy paths share it.
- `executeSnippet(snippet)` rewritten with two branches:
  - **Scoped** (`snippet.server_id` set): if the server no longer exists,
    show a warning and *auto-open the edit modal* to reassign, then abort.
    Otherwise `ensureConnectedSessionForServer`, bail silently if it returns
    null, else `sendSnippetToSession`.
  - **Legacy/global** (`server_id` null): unchanged old behavior — requires
    an active session, warns "No Active Session" otherwise.
- Snippet cards now render a `.server-card-subtitle` line with the scope
  label, and the Run button's `aria-label` reflects the target
  (`Run X on Y` vs `Run X in the active terminal`).
- `openSnippetModal` / `openSnippetEditModal` populate the new select;
  edit passes `snippet.server_id || ""`.
- `saveSnippet` now trims `name` and `description`, reads `snippet-server`,
  writes `server_id: serverId || null`, and adds three validations that
  previously did not exist (empty name, empty command, stale server ID).
  Note `name`/`command` trim-then-store is new; `command` is **not** stored
  trimmed (multi-line scripts keep their formatting).
- `loadServers()` now also calls `renderSnippetList()` and
  `syncSnippetServerSelect()`, so a server rename/delete is reflected in
  snippet cards and the open modal without a reload.

### `frontend/index.html`

- Snippet modal gains a Server `<select id="snippet-server">` plus help text
  (`id="snippet-server-help"`) placed between Name and Command, wired via
  `aria-describedby`.

## Verification performed

All static — the app has not been launched with this change.

```bash
node --check frontend/main.js                              # ok
node --check frontend/components/session-manager.js        # ok
cargo fmt --all --check                                    # ok
cargo test --workspace                                     # 73 passed, 0 failed (whole workspace)
cargo clippy --workspace --all-targets -- -D warnings      # clean
```

## Known gaps and follow-ups

1. **Never run in the app.** `npm run tauri dev` has not been used to click a
   scoped snippet end-to-end (connect-on-demand, reuse-live-session, missing
   server path). This is the single biggest unverified item.
2. **Session-limit silent no-op.** When 5 live sessions already exist,
   `connectSession` returns `null` and the snippet does nothing. The guard
   shows an alert, so it is not silent-silent, but `executeSnippet`'s
   `if (!session) return;` swallows the result with no snippet-specific
   message. Candidate fix: toast "session limit reached, snippet not run".
3. **No frontend tests.** There is no JS test harness in this repo, so the
   branch logic is only covered by manual use.
4. **All existing snippets are global.** Live data has 14 snippets, none
   scoped. Until they are assigned servers they keep the legacy behavior and
   remain unrunnable by the future CLI. A bulk-assign affordance does not
   exist; open product question.
5. **No `timeout_seconds` on snippets.** Resolved for the CLI without a schema
   change: `run` defaults to 60s and clamps `--timeout` to 5–600s. Snippets
   still have no per-snippet timeout, so the desktop paste path stays
   unbounded, which is correct for an interactive terminal.

## Unresolved: does this replace Actions?

Scoped snippets now do what Actions were built to do — run a stored command
against a chosen server. Differences that remain:

| | Scoped snippet | Action |
|---|---|---|
| Output | Live in the terminal, uncaptured | Captured, bounded to 64 KiB |
| History | None | `action-history.json`, last 250 runs |
| Status tracking | None | `last_executed_at` / `last_execution_status` |
| Timeout | None | `timeout_seconds`, 5–600s clamp |
| Run mode | Visible, interactive, PTY | Headless, one-shot |
| Server binding | `Option<String>` | Required `String` |

Ken's stated direction: scoped snippets are what he wanted Actions to be, so
Actions may be removable. The CLI now also covers the captured-output and
history case, which removes Actions' last unique capability. **No decision has
been made and no code has been removed** — the execution plumbing that Actions
used is now shared `ssh-thing-core` code that the CLI depends on, so removing
Actions no longer means removing that code. See decision D1 in
`docs/STATE-OF-WORK.md`.

If the answer becomes "remove it", the inventory is: the Actions tab and
`frontend/components/actions-manager.js`, the `get_actions` / `add_action` /
`update_action` / `delete_action` / `get_action_history` / `execute_action`
commands, the `action-execution` event listener, the Actions section of the
snippet/action export envelope (`ExportData.actions`), and
`action-history.json`. The `Action`, `ActionHistoryEntry`, and
`ActionExecutionEvent` types themselves now live in `ssh-thing-core` alongside
`exec_command`, so the *execution* layer survives regardless.

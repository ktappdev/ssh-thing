# State of Work — Entry Point

**Read this first.** This is the living handoff document for the ssh-thing
repository. If you are picking the project up cold, this file tells you where
things stand.

Last updated: **2026-09-16**, at app version **1.1.33**, tag **v1.1.33**. The tip
of `main` is the state of work; take its hash from `git log -1` instead of
trusting a hash written here.

## Where you are in one paragraph

The desktop app shipped 1.1.33. Since then, three bodies of work landed, and a
fourth pass reviewed and hardened them. **One:** snippets are server-scoped and
connect on demand. **Two:** a Rust workspace now exists — `ssh-thing-core` holds
the shared model, storage, secrets, and SSH code, and `ssh-thing-cli` is a
working capability-limited CLI for LLMs. **Three:** the desktop app grew an
Automation panel that gates the CLI and installs it from GitHub Releases.
**Four:** the CLI was reviewed against its own spec and six defects were fixed — one timeout
clamp instead of two, a corrupt gate file that now refuses instead of reporting
a failed run, `update_available` that no longer lies about a machine with no
CLI installed, a checksum parser that accepts BSD format, a single read of
`servers.json` in `doctor`, and a new `doctor.runnable` field. The desktop
binary, the CLI binary, all tests, clippy, and formatting are green. **Five:**
the CLI was then run for real against the live data directory — read-only
commands only, no snippet executed — which caught a seventh defect (argument
errors exited 2 with an empty stdout, colliding with "ran and failed") and
proved `stamp_app_version` works, since `version` went from `app_version: null`
to `1.1.33` the moment the desktop app launched. **Six:** the beads issue tracker
was removed from the repository. What has **not** happened: no snippet has been
run through the CLI against a real server, and the installer has never
downloaded a real release asset, because no published release carries CLI
binaries yet.

## Documents in this repository, and what each is for

| File | Purpose | Status |
|---|---|---|
| `docs/STATE-OF-WORK.md` | **This file.** Current state, uncommitted work, open decisions, next steps. | Living |
| `docs/CLI-FOR-LLMS.md` | Product spec for the LLM CLI: goal, UX, security model, distribution, decisions. | Spec, **now implemented** — see the status header |
| `docs/CLI-KNOWLEDGE-BASE.md` | Engineering ground truth: coupling map, core layout, verified facts, and the implementation record. | Current |
| `FEATURE_SCOPED_SNIPPETS.md` | Implementation record for server-scoped snippets. | Current |
| `FEATURE_ACTIONS.md` | The original Actions design doc. Superseded by scoped snippets; Actions still exists. | Historical, see decision D1 |
| `AGENTS.md` | Repo-wide agent guidelines: build commands, release process, code style, docs map. | Current — **see trap #2** |

## Working tree state

Branch `main`, clean and level with `origin/main`. Seven commits sit on top of
`4b60c9a "Release v1.1.33"`; the list grows as work lands, so treat `git log` as
the source of truth:

```text
1eb5b00  Make argument errors obey the documented usage contract
c2ff05c  Remove the beads issue tracker from the project
3dca514  Record the hardening pass in the handoff docs
63eda74  Harden the CLI: one timeout clamp, honest gate and install status
afc8324  Add integration coverage for the CLI refusal paths
d138fe6  Record the committed state in STATE-OF-WORK
d2379ad  Add shared core, LLM CLI, and automation panel
```

`d2379ad` is the feature commit. It contains:

```text
 .github/workflows/release.yml         build-cli job + .sha256 assets
 AGENTS.md                             docs map, key files, CLI commands, release notes
 Cargo.toml / Cargo.lock               workspace members, workspace.package version
 frontend/index.html                   Automation menu item, modal, styles
 frontend/main.js                      automation wiring, upsert_secret key fix
 frontend/components/session-manager.js scoped-snippet auto-connect
 src-tauri/Cargo.toml                  ssh-thing-core path dep; keyring + toml dropped
 src-tauri/src/actions.rs              delegates exec + history to core
 src-tauri/src/lib.rs                  thin wrappers over core, new commands
 src-tauri/src/cli_manager.rs          installer + CLI status commands
 crates/ssh-thing-core/                6 modules, no tauri dependency
 crates/ssh-thing-cli/                 3 modules, binary "ssh-thing"
 frontend/components/automation-manager.js
 docs/CLI-FOR-LLMS.md, docs/CLI-KNOWLEDGE-BASE.md, docs/STATE-OF-WORK.md
 FEATURE_SCOPED_SNIPPETS.md
```

## Verification status

Run and passing on the current tree:

```bash
node --check frontend/main.js
node --check frontend/components/automation-manager.js
cargo fmt --all --check
cargo test --workspace                                # 92 passed, 0 failed
cargo clippy --workspace --all-targets -- -D warnings  # clean
cargo build -p tauri-app                              # links
cargo build --release -p ssh-thing-cli                # 3.99 MB binary
```

`crates/ssh-thing-cli/tests/cli.rs` runs the real binary against a fixture data
directory for 18 cases, with no network access: the automation gate refuses,
an unreadable `settings.json` refuses as `settings_unreadable`, unscoped
snippets refuse, cross-server requests refuse, a snippet whose server vanished
refuses, ambiguous and unknown selectors exit 1, `--dry-run` resolves without
connecting, both the timeout floor and ceiling are clamped and reported,
`doctor` never claims `runnable` with the gate off, `servers` output carries no
secret material, history records the run, and argument errors (unknown
subcommand, missing flag, invalid value) exit 1 with the JSON envelope instead
of clap's exit 2 and empty stdout.

Manually verified on top of that: a refused TCP connect is reported with the
full report attached, and an **unknown host key is refused while
`known_hosts.json` stays byte-identical** (checked against `github.com:22`).

Also checked by hand against the release binary with a fixture data directory:
`--timeout 1` reports `timeout_seconds: 5` with `timeout_clamped: true`;
`settings.json` containing `null` exits 3 with `settings_unreadable`; and
`doctor --human` prints `Runnable now: no` with the gate off while every other
check passes.

### Live run against the real data directory

First execution of the CLI against
`~/Library/Application Support/com.kentaylor.ssh-thing`. Read-only commands and
pre-flight refusals only — **no snippet has been executed against a real
server.** At the time of the run: 5 servers, 15 snippets, gate off, keychain
probe passing.

| Check | Observed |
|---|---|
| `version` | exit 0; `app_version` was `null` until the desktop app was launched, then `1.1.33` — first proof `stamp_app_version` works |
| `servers` / `--human` | exit 0; labels, snippet counts, `host_key_trusted: false` for all five |
| `snippets` | exit 0; `runnable: 0` of 15 initially, every one `not_scoped_to_a_server` |
| `snippets --server <nonsense>` | exit 1 `usage`, hint points at `ssh-thing servers` |
| any `run`, `--dry-run` included | exit 3 `automation_disabled` **before** resolving the snippet, so nothing connects |
| `history` | exit 0, empty |
| `doctor` | exit 0; `healthy: true`, `runnable: false` — the distinction `runnable` was added for |
| secret material on stdout | none: no `secret_id`, no `private_key`, no `password` |
| argument errors | **defect found** — clap exited 2 with empty stdout; fixed in `1eb5b00` |

Then the UI path was exercised for the first time. Scoping the `List` snippet to
`server2` in a `npm run tauri dev` session was picked up by the CLI immediately:
`snippets` reported `runnable: true`, `server_label: server2`, and `doctor` moved
to `1 runnable of 15 total`. That is the whole curation chain — modal select →
`saveSnippet` → store → CLI read — now verified end to end.

Three things to carry forward:

- The automation gate is checked **before** selector resolution, so with
  automation off an unknown snippet reports `automation_disabled`, not `usage`.
- `--dry-run` is gated too. Resolving a run without connecting needs no
  permission in principle; today it needs the toggle. Flagged as a candidate
  change, not made.
- The first CLI run against a real server will likely raise a macOS keychain
  prompt, because the CLI is a different binary from the app that stored the
  secret.

**Not verified — the honest gaps:**

- No *successful* remote command through the CLI, and no snippet has been run
  from the CLI at all. Every live-data check above stops before a connection.
  `core::ssh::exec_command` is the same code path the desktop Actions use, so the
  risk is low, but it is unproven.
- **The Automation panel has still never been operated.** A snippet was scoped
  in the dev app, but the `allow_external_automation` toggle has not been
  flipped by a human, and Install CLI has never been pressed.
- The installer has never downloaded a real asset: no release carries CLI
  binaries yet. The first release with the new workflow will be the first real
  test of `install_cli`.

## Open decisions

| # | Decision | Status |
|---|---|---|
| **D1** | Does Actions get removed? | **Open.** Scoped snippets do what Actions were built for, and the CLI now covers the "capture output" case. Actions still exists, untouched and deprecated in docs. Removing it is a sizeable, separately reviewable change. |
| **D2** | Headless keyring fallback | **Decided:** environment override only. `SSH_THING_SECRET_<SANITIZED_SECRET_ID>` is checked before the keychain; blank values are ignored. No plaintext file store. `doctor` prints the variable name for every server. |
| **D3** | CLI install target + PATH policy | **Decided:** `~/.local/bin` only. No elevation, no system-wide install. The app prints an `export PATH=...` hint and never edits shell rc files. |
| **D4** | `run` flag shape | **Decided:** `--snippet` is required and carries the capability; `--server` is optional but must match the snippet's own scope, otherwise the run is refused. |
| **D5** | Destructive-snippet approval | **Decided for v1:** no per-snippet approval. The single `allow_external_automation` toggle is the gate. Revisit if it is ever turned on in practice. |
| **D6** | R2 vs GitHub Releases | **Decided:** GitHub Releases, with published `.sha256` files. |
| **D7** | Keep the Homebrew cask gated on the CLI build? | **Decided:** yes. `update-homebrew` still needs `[build, build-cli]`. A CLI build failure delays the cask but can never publish a partial release; the DMGs and the GitHub Release are unaffected. |

## Action items (not decisions)

1. **⚠️ Rotate the `server2` credential.** During earlier keychain research a
   `security find-generic-password ... -g` invocation printed a live password
   into a session transcript. The value is deliberately not recorded in these
   docs. Rotate it.
2. **Traps in this environment:**
   - `release-builds/` contains **1.1.32** DMGs while `package.json` is
     **1.1.33**. Stale; not the current artifacts.
   - `docs/PRD-Automatic-Updates.md` and `docs/feature-research-roadmap-2026-03-06.md`
     predate this work and were not reviewed here.
3. `src-tauri` has no `version` key, so `env!("CARGO_PKG_VERSION")` there is
   `0.0.0`. Always take the version from `ssh_thing_core::VERSION`.

## Next steps, in recommended order

1. **Finish the first end-to-end run.** The `List` snippet is scoped to
   `server2` and the CLI can see it. What is left is the gate: header menu →
   Automation → *Allow external automation*, then

   ```bash
   ./target/release/ssh-thing run --snippet List --dry-run   # resolve only
   ./target/release/ssh-thing run --snippet List             # actually runs ls
   ```

   Expect a one-time macOS keychain prompt. This is the single most important
   unverified path in the project, and flipping the toggle also exercises the
   only guardrail the CLI obeys.
2. **Cut the first release with CLI assets.** Bump the patch version so
   `build-cli` runs, confirm the three `ssh-thing_<version>_<platform>` assets and
   their `.sha256` files appear on the release, then use Install CLI for real.
   This turns `install_cli` from untested into tested, and it is what puts the
   Server dropdown and Automation panel in front of a normal user — the released
   1.1.33 build has neither.
3. **Then decide D1** and, if Actions goes, remove it in its own commit.

## Things a fresh agent must not assume

- **The installed app is behind the working tree.** `/Applications/SSH THING.app`
  is the released **1.1.33**, which predates this work: `git show
  v1.1.33:frontend/index.html` contains no `snippet-server` element and no
  Automation panel. Scoping a snippet, or enabling automation, requires
  `npm run tauri dev` (which serves `frontend/` directly) or a new release. A
  consequence worth knowing: the released frontend has no `server_id` field, so
  **editing a snippet in the installed app saves it without a scope and silently
  drops one set in a dev build.** Both apps share one data directory and one
  keychain service.
- No published release contains a CLI binary. `cli_status` reports the CLI as
  **not installed** (it no longer reports "Update available" for a machine with
  nothing installed), and `install_cli` will fail with a 404 until a release is
  cut with the new workflow.
- Snippets are not server-scoped *in the released 1.1.33 build*. In the live data
  directory exactly one snippet is scoped (`List` → `server2`), so it is the only
  CLI-runnable snippet: `doctor` reports `1 runnable of 15 total`. The live data
  also holds a second, unscoped `list` snippet that looks like a duplicate.
- `allow_external_automation` defaults to false. The CLI can list things but
  refuses every run until the toggle is flipped in the desktop app.
- The CLI has no write path: it cannot scope a snippet, create a server, or flip
  the gate. Hand-editing `snippets.json` / `settings.json` works but bypasses the
  UI that is supposed to be the curation surface.
- Do not run `release-tag.sh --allow-dirty` to work around uncommitted files;
  `AGENTS.md` explicitly calls that wrong.

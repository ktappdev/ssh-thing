# State of Work — Entry Point

**Read this first.** This is the living handoff document for the ssh-thing
repository. If you are picking the project up cold, this file tells you where
things stand.

Last updated: **2026-09-16**, at app version **1.1.33**, tag **v1.1.33**.

## Where you are in one paragraph

The desktop app shipped 1.1.33. Since then, three bodies of work landed on an
uncommitted tree. **One:** snippets are server-scoped and connect on demand.
**Two:** a Rust workspace now exists — `ssh-thing-core` holds the shared model,
storage, secrets, and SSH code, and `ssh-thing-cli` is a working
capability-limited CLI for LLMs. **Three:** the desktop app grew an Automation
panel that gates the CLI and installs it from GitHub Releases. The desktop
binary, the CLI binary, all tests, clippy, and formatting are green. What has
**not** happened: nobody has clicked the Automation panel, and the installer has
never downloaded a real release asset, because no published release carries CLI
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

## Working tree state (uncommitted)

Branch `main`, tracking `origin/main`. Last commit `06994fd "Filter stale
release assets"` on top of `4b60c9a "Release v1.1.33"`.

Everything below is uncommitted and unpushed:

```text
 M .github/workflows/release.yml         add build-cli job + .sha256 assets
 M AGENTS.md                             docs map, key files, CLI commands
 M Cargo.toml                            workspace members + workspace.package
 M Cargo.lock                            new deps (clap, dirs, reqwest, sha2, hex)
 M frontend/index.html                   Automation menu item, modal, styles
 M frontend/main.js                      automation manager wiring, upsert_secret key fix
 M frontend/components/session-manager.js scoped-snippet auto-connect
 M src-tauri/Cargo.toml                  ssh-thing-core path dep; drop keyring+toml
 M src-tauri/src/actions.rs              delegates exec + history to core
 M src-tauri/src/lib.rs                  thin wrappers over core, new commands
?? crates/                                ssh-thing-core + ssh-thing-cli (12 files)
?? src-tauri/src/cli_manager.rs           installer + CLI status commands
?? frontend/components/automation-manager.js
?? docs/CLI-FOR-LLMS.md
?? docs/CLI-KNOWLEDGE-BASE.md
?? docs/STATE-OF-WORK.md
?? FEATURE_SCOPED_SNIPPETS.md
```

## Verification status

Run and passing on the current tree:

```bash
node --check frontend/main.js
node --check frontend/components/automation-manager.js
cargo fmt --all --check
cargo test --workspace                                # 73 passed, 0 failed
cargo clippy --workspace --all-targets -- -D warnings  # clean
cargo build -p tauri-app                              # links
cargo build --release -p ssh-thing-cli                # 3.99 MB binary
```

The CLI was exercised end to end against a fixture data directory
(`SSH_THING_DATA_DIR`). Verified: the automation gate refuses, unscoped snippets
refuse, cross-server requests refuse, `--dry-run` resolves without connecting,
a refused TCP connect is reported, and an **unknown host key is refused while
`known_hosts.json` stays empty** (checked against `github.com:22`).

**Not verified — the honest gaps:**

- No *successful* remote command through the CLI. No reachable non-production
  test host was available. `core::ssh::exec_command` is the same code path the
  desktop Actions use, so the risk is low, but it is unproven.
- Nothing clicked in the GUI. The Automation panel and the Install CLI button
  have never been run by a human.
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

## Action items (not decisions)

1. **⚠️ Rotate the `server2` credential.** During earlier keychain research a
   `security find-generic-password ... -g` invocation printed a live password
   into a session transcript. The value is deliberately not recorded in these
   docs. Rotate it.
2. **Traps in this environment:**
   - `br` (beads) is **not installed**, although `AGENTS.md` mandates it for all
     task tracking. Do not follow that instruction blindly here — it fails with
     `command not found`. Install `br`, or use the `todo` tool and say so.
   - `release-builds/` contains **1.1.32** DMGs while `package.json` is
     **1.1.33**. Stale; not the current artifacts.
   - `docs/PRD-Automatic-Updates.md` and `docs/feature-research-roadmap-2026-03-06.md`
     predate this work and were not reviewed here.
3. `src-tauri` has no `version` key, so `env!("CARGO_PKG_VERSION")` there is
   `0.0.0`. Always take the version from `ssh_thing_core::VERSION`.

## Next steps, in recommended order

1. **Dogfood before committing further.** `npm run tauri dev`, then: open the
   header menu → Automation, turn on *Allow external automation*, scope a snippet
   to a real server, and run one Action to confirm the refactored execution path
   still works.
2. **Commit in three chunks** so history stays reviewable:
   scoped snippets; the core extraction + CLI; the Automation panel + CI.
3. **Cut the first release with CLI assets.** Bump the patch version so
   `build-cli` runs, confirm the three `ssh-thing_<version>_<platform>` assets and
   their `.sha256` files appear on the release, then use Install CLI for real.
4. **Then decide D1** and, if Actions goes, remove it in its own commit.

## Things a fresh agent must not assume

- No published release contains a CLI binary. `cli_status` reports
  "Update available" and `install_cli` will fail with a 404 until a release is
  cut with the new workflow.
- Snippets are not server-scoped *in the released 1.1.33 build*; all 14 snippets
  in the live data directory are still unscoped, so **nothing is CLI-runnable
  today**. The CLI reports `snippets_load: 0 runnable of 14 total`.
- `allow_external_automation` defaults to false. The CLI can list things but
  refuses every run until the toggle is flipped in the desktop app.
- Do not run `release-tag.sh --allow-dirty` to work around uncommitted files;
  `AGENTS.md` explicitly calls that wrong.

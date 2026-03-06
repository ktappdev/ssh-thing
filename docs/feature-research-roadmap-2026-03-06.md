# SSH Thing Feature Research & Decisions (2026-03-06)

## Scope
This document evaluates the proposed features against:
- User expectation in modern SSH clients
- Fit with SSH standards and common workflows
- Implementation complexity/risk in current codebase (`frontend/main.js`, `src-tauri/src/lib.rs`)

## What We Will Definitely Add
These are approved for upcoming implementation work:

1. SSH key file picker (import key file)
2. Server groups/folders
3. Quick Connect (no save)
4. Reconnect UX (manual reconnect button only)
5. Terminal search (`Cmd+F`, xterm search addon)
6. Larger/configurable scrollback
7. Duplicate server entry
8. Connection timeout setting
9. Last connected timestamp
10. Background disconnect notifications
11. Confirm before closing app with active sessions
12. Terminal font size controls (+ shortcuts)
13. Keyboard shortcuts for new connection / quick connect
14. Snippet execution feedback improvements
15. Snippet delete modal consistency
16. Error handling consistency (`showAlert` standardization)

## Decision Matrix

### High Priority Suggestions
1. SSH key file picker: **YES**
- Demand: High
- Why: Standard workflow across SSH tools; current paste-only flow is friction-heavy.

2. Server groups/folders: **YES**
- Demand: High
- Why: Essential once host count grows; aligns with competitor organization patterns.

3. Quick connect (without saving): **YES**
- Demand: High
- Why: Common one-off workflow for ephemeral hosts.

4. Reconnect on disconnect: **YES (manual only)**
- Demand: High
- Why: Users expect fast recovery after drops.
- Scope call: Ship explicit reconnect only; skip auto-retry/reconnect automation for now.

5. Search/filter in terminal output: **YES**
- Demand: High
- Why: Core terminal ergonomics; direct support via xterm addon.

6. Larger scrollback buffer: **YES**
- Demand: High
- Why: 1000 lines is too small for operational logs.

7. Export/import server list: **SKIP (for now)**
- Demand: High
- Why: Deferring due to schema/secret handling risk in this phase.

### Medium Priority Suggestions
8. Drag-and-drop server reordering: **LATER**
- Demand: Medium
- Why: Helpful but lower value than groups + recent usage sort.

9. Duplicate server entry: **YES**
- Demand: Medium-high
- Why: Very common admin workflow with low implementation risk.

10. Connection timeout configuration: **YES**
- Demand: Medium-high
- Why: Real-world VPN/high-latency setups need this control.

11. Snippet categories/tags: **LATER**
- Demand: Medium
- Why: Useful at scale but currently secondary to search and snippet variables.

12. Snippet variables/placeholders: **LATER**
- Demand: Medium
- Why: Strong power-user value, but needs careful UX and escaping rules.

13. Last connected timestamp: **YES**
- Demand: Medium-high
- Why: Immediately useful for pruning stale hosts and sorting.

14. Connection duration display: **LATER**
- Demand: Medium
- Why: Nice visibility, but lower impact than reconnect/notifications.

15. Notification on disconnect (background tab): **YES**
- Demand: Medium-high
- Why: Prevents silent failure when multitasking.

16. Confirm before closing app with active sessions: **YES**
- Demand: High
- Why: Strong data-loss/surprise-prevention UX.

### Nice-to-Have Suggestions
17. Split terminal panes: **LATER**
- Demand: Medium for power users
- Why: High UI/PTY complexity; defer until core ergonomics are done.

18. SFTP/file transfer: **LATER**
- Demand: High
- Why: Valuable but substantial scope (new UI, transfer state, conflict/error UX).

19. Port forwarding (tunnels): **LATER (but planned)**
- Demand: High
- Why: Core SSH capability; larger backend/state surface.

20. SSH agent forwarding: **SKIP (for now)**
- Demand: Medium-high
- Why: Security-sensitive and platform-specific; out of current scope.

21. Session logging/recording: **SKIP (for now)**
- Demand: Medium-high
- Why: Needs careful secret-redaction/retention policy before shipping.

22. Customizable terminal font size: **YES**
- Demand: High
- Why: Accessibility and usability baseline.

23. Keyboard shortcut for new connection: **YES**
- Demand: Medium
- Why: Low effort, improves flow for keyboard-first users.

24. Sidebar collapse/resize: **LATER**
- Demand: Medium
- Why: Useful but not a blocker; can follow after grouping/search updates.

25. Jump host/proxy support: **SKIP (for now)**
- Demand: High
- Why: Connection orchestration complexity is too high for the next tranche.

### "Better Ways" Suggestions
A. Snippet execution feedback: **YES**
- Demand: Medium
- Why: Better command confidence and reduced ambiguity.

B. Server card connect/disconnect UX refactor: **LATER**
- Demand: Medium (quality)
- Why: Good cleanup, but not user-visible enough for top tranche.

C. Snippet delete confirmation consistency: **YES**
- Demand: Medium
- Why: Low effort, improves trust/consistency.

D. Error handling consistency: **YES**
- Demand: High (quality)
- Why: Prevents jarring native dialogs and uneven UX.

E. Terminal renderer change (DOM -> canvas/WebGL): **LATER**
- Demand: Medium
- Why: Should be benchmark-driven and resilient to WebGL context loss.

F. Auth type: SSH agent: **SKIP (for now)**
- Demand: High among dev/ops users
- Why: Same security/platform concerns as agent forwarding.

G. Welcome screen improvements: **LATER**
- Demand: Medium-low
- Why: Nice polish, but lower ROI than core connection workflows.

## Notes From Current Codebase
- `frontend/main.js` is ~1525 lines and should be split into components/modules while implementing these changes.
- Existing terminal config currently uses `scrollback: 1000`, `fontSize: 14`, `rendererType: 'dom'`.
- Error/confirmation UX is currently mixed across `alert`, `confirm`, and custom modals.
- Existing auth model supports password + pasted private key, so file import is a natural extension.

## Evidence Sources
- xterm addons guide: https://xtermjs.org/docs/guides/using-addons/
- xterm terminal options (`scrollback`, `fontSize`): https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/
- xterm search addon (`findNext`): https://github.com/xtermjs/xterm.js/tree/master/addons/addon-search
- xterm webgl addon: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl
- OpenSSH client config (`ConnectTimeout`, `ForwardAgent`, `ProxyJump`, `LocalForward`, `RemoteForward`): https://man.openbsd.org/OpenBSD-6.9/ssh_config.5
- Termius key import from file: https://termius.com/documentation/import-ssh-keys
- Termius jump host docs: https://termius.com/documentation/jump-hosts
- Termius proxy docs: https://termius.com/documentation/proxy
- Termius port forwarding docs: https://termius.com/documentation/port-forwarding
- WinSCP private key path + import/migration docs: https://winscp.net/eng/docs/guide_public_key and https://winscp.net/eng/docs/ui_import
- PuTTY logging + saved sessions + keepalive options: https://the.earth.li/~sgtatham/putty/0.76/htmldoc/Chapter4.html

# NEXT_STEPS.md — Living Build Queue

> Read this at the start of every session to pick up where the last one left off.
> Update it at the end of every session where anything changed (Agent Guideline #10).

---

## Current state

- **Cursor support added (decision 018) — in verification.** Cursor's native agent is now
  tracked on the same bar: Cursor bridges Claude Code hooks (runs `~/.claude/status/report.sh`
  from `~/.claude/settings.json`), so running/idle/error/remove work for free; native
  `~/.cursor/hooks.json` entries ([hooks/cursor-setup.mjs](hooks/cursor-setup.mjs)) add
  `subagentStart/Stop` + `postToolUseFailure` (the events the bridge drops). `report.sh` now
  handles Cursor payloads (`workspace_roots` cwd, camelCase events, `Stop.status` error,
  `empty-state-draft` skip) and writes an `ide` field driving per-IDE click-to-focus. **Two
  things left:** (1) a live **folder-open** Cursor run to confirm end-to-end — Cursor runs
  **no** hooks in a folder-less window (`MainThreadShellExec not initialized`); (2) rebuild the
  app + port `cursor-setup.mjs` into `install.rs` so the packaged app self-installs the Cursor
  hooks and the running bar reads `ide`. Verification tooling
  ([hooks/cursor-log-events.sh](hooks/cursor-log-events.sh),
  [hooks/cursor-logger-setup.mjs](hooks/cursor-logger-setup.mjs)) kept for future Cursor
  versions. Blocked (orange) is unavailable on Cursor (no event).
- **Milestones 1–6 done — v1 complete.** Two shipping surfaces off one signal layer:
  (1) `/Applications/ClaudeStatus.app` — floating always-on-top bar of all sessions; self-
  installs its hooks on launch. (2) The **VS Code extension** — per-window status-bar items.
  Features: four-state lights, hover (task/activity), click-to-focus, subagent badges, floats
  over full-screen, drag + position-memory, dead-session pruning. **Remaining is polish /
  distribution only:** confirm the interim error (red) signal from live `StopFailure`;
  marketplace-publish the extension; optional launch-at-login toggle; app code signing.
  Details of each milestone below.
- **Milestone 1 complete — event model verified on Claude Code 2.1.201** (full evidence in
  [DECISIONS.md](DECISIONS.md) #006). The temporary broad logger has been **uninstalled**;
  the user's global `~/.claude/settings.json` is back to clean (permissions + theme, no
  hooks). Capture evidence retained in `logs/events.log` (gitignored). The logger tooling
  ([hooks/log-events.sh](hooks/log-events.sh), [hooks/logger-setup.mjs](hooks/logger-setup.mjs))
  stays in the repo for re-running verification on future Claude Code versions.
- **Verified signal contract (use this in Milestone 2):**
  - 🟢 running ← `UserPromptSubmit`, `PreToolUse`, `PostToolUse`
  - 🟠 blocked ← `PermissionRequest` (**not** `Notification` — that never fired; corrects the
    earlier assumption). Fires for tool approvals *and* `AskUserQuestion`; `tool_name`
    distinguishes them. No "resolved" event — infer unblocked from the next event.
  - ⚪ idle ← `Stop`, `SessionStart`
  - 🔴 error ← `PostToolUseFailure` **(interim, low confidence — noisy)**; wants a real
    turn-level `StopFailure`, not yet observed. See Milestone 2 calibration item.
  - remove ← `SessionEnd`
- **Key facts confirmed:** hooks in global settings apply **immediately to running
  sessions** (no restart); every event carries `session_id` + `cwd` (but `Stop` carries
  *only* those two — don't rely on `transcript_path`/`prompt_id` being present); a window can
  spawn **many short-lived sessions**; hooks are **session-level** (no subagent lights); the
  **workspace folder** (from `cwd`, cross-checked against `~/.claude/ide/*.lock`) is the
  window key; auto "this window" is the extension's job.
- **What we're building:** a small, always-on-top, drag-to-position bar of colored lights,
  one per open Claude Code session — 🟢 running, 🟠 blocked (waiting for input), ⚪ idle,
  🔴 error. See [CLAUDE.md](CLAUDE.md) Project Overview.
- **Architecture (two layers), all logged in [DECISIONS.md](DECISIONS.md):**
  - **Signal:** Claude Code **hooks** (decision 001) write session state to a shared JSON
    file `~/.claude/status/sessions.json` (decision 002), keyed by `session_id`.
  - **Display:** a **Tauri** borderless always-on-top window (decision 003) watches that
    file and renders the lights; sessions keyed by `session_id`, labeled by project folder,
    with heartbeat-based staleness (decision 004).
- **Event → state mapping (to be verified against the installed version — see Now):**
  `UserPromptSubmit`/`PreToolUse` → green; `Notification`/`PermissionRequest`/`Elicitation`
  → orange; `Stop`/`SessionStart` → gray; `StopFailure`/`PostToolUseFailure` → red;
  `SessionEnd` → remove.
- **Known open risk:** several of those event names come from docs and are version-dependent
  (Agent Guideline #4). The `Notification` / `Stop` / `UserPromptSubmit` / `SessionEnd` core
  is high-confidence; the error/permission events need confirming.

---

## Target architecture (working sketch)

```
ClaudeStatus/
├─ hooks/            # shell scripts + installer for the status hooks
│   ├─ log-events.sh   # TEMPORARY Milestone 1 event logger (remove after verification)
│   ├─ logger-setup.mjs# TEMPORARY install/uninstall for the logger
│   └─ report.sh       # (M2) the real hook: writes session state to the status file
├─ app/              # Tauri project — core floating bar + self-installer (decision 005)
│   ├─ src-tauri/    # Rust: borderless always-on-top window, status-file watcher, hook install
│   └─ src/          # web UI: renders lights from the status JSON
├─ extension/        # (later) optional VS Code extension — marketplace install + click-to-focus
├─ install.sh        # interim one-command installer until the app hosts the install logic
└─ README.md
```

**Data contract** — one file per session (decision 007):
`~/.claude/status/sessions/<session_id>.json` (dir overridable via `$CLAUDESTATUS_DIR`):
```json
{
  "state": "running|blocked|idle|error",
  "cwd": "/path/to/project",
  "label": "project-name",
  "updated_at": 1751731200
}
```
The app watches the `sessions/` directory. `SessionEnd` deletes the file. Errors also append
to `~/.claude/status/calibration.log` (calibration only — no `tool_input`).

---

## Now (build queue, in order)

1. ✅ **Milestone 1 — Verify hooks.** *Done 2026-07-05.* Verified event→state mapping on
   Claude Code 2.1.201 (DECISIONS.md #006); logger uninstalled; settings clean.
2. ✅ **Milestone 2 — Signal layer.** *Done 2026-07-05.* Built [hooks/report.sh](hooks/report.sh)
   (fast, non-blocking, fail-silent; one file per session per decision 007) + the idempotent,
   reversible installer [hooks/setup.mjs](hooks/setup.mjs) (`install`/`uninstall`/`status`).
   Unit-tested every branch, replay-validated against the 160 real M1 events, and **installed
   live** — `~/.claude/status/sessions/` now updates in real time from running sessions.
   Error signal still interim (`PostToolUseFailure`, `is_interrupt==false`); `report.sh`
   mirrors failure events to `~/.claude/status/calibration.log` to confirm a real `StopFailure`
   trigger from live data over time.

## Next

3. ✅ **Milestone 3 — Tauri shell.** *Done 2026-07-05.* Rust toolchain installed; Tauri v2
   app in `app/` runs as a **non-activating NSPanel overlay** (decision 008): borderless,
   transparent, floats over everything incl. other apps' full-screen spaces, drag-to-move,
   position remembered, no Dock icon. Polls `list_sessions` (reads `~/.claude/status/sessions/`)
   and renders colored dots. Verified live floating over full-screen VS Code.
4. **Milestone 4 — Light UI + interaction.** *In progress.* Done: four-color dots;
   **click-to-focus** (click a light → focus the session's window via the IDE CLI
   `code`/`cursor <workspace-root>`, resolved from `~/.claude/ide/*.lock`; Space-aware, never
   spawns a new window — decision 016, replaced the `open -a <folder>` that duplicated windows;
   drag handle = pill padding; a fast `osascript` window-raise added for same-Space switches,
   ~0.2s vs the CLI's ~1.1s — decision 021, needs Accessibility, degrades to the CLI without it);
   dead-session pruning (2h, replaced heartbeat-dimming);
   **hover tooltip** (task + current activity, native OS tooltip); **subagent count badge**
   (decision 009). Remaining: optional visual polish (pulse on blocked/error is in CSS;
   spacing/size tuning), and confirm the interim error (red) signal from live `StopFailure`
   data (M1/M2 calibration item).
5. ✅ **Milestone 5 — Self-installing app + installer (decisions 005, 011).** *Done
   2026-07-05.* App self-installs its hooks on launch (embedded `report.sh` →
   `~/.claude/status/report.sh` + settings.json merge, release-only); `tauri build` produces
   `.app` + `.dmg`; [install.sh](install.sh) builds + installs to `/Applications`;
   [README.md](README.md) written. Verified: launched the packaged app, it wired up all 11
   hooks (deduped, backed up, non-clobbering) with zero external steps. Installed at
   `/Applications/ClaudeStatus.app` and running. *Deferred:* launch-at-login is a manual
   Login-Items step (a `tauri-plugin-autostart` toggle is a future enhancement); code signing
   (unsigned → Gatekeeper right-click-Open only when redistributed).

## Later

6. ✅ **Milestone 6 — VS Code extension (decisions 005, 006, 012).** *Done 2026-07-05.*
   `extension/` shows per-window status-bar items (scoped to the window's workspace), hover
   detail (task/activity/subagents), and click-to-focus a specific session's tab via
   `claude-vscode.editor.open` (no URI prompt). Guarded hook-ensure. Packaged as `.vsix`,
   installed via the `code` CLI, verified live. **Remaining:** marketplace publish (needs a
   verified publisher account — distribution, not build).
7. **(Promoted into M4) — click-to-focus from the bar.** Clicking a light focuses that
   session's window. Approach: a Rust command opens a `vscode://` deep link
   (`tauri_plugin_opener` is already a dep), with a `code <cwd>` fallback to at least focus the
   workspace window. Exact deep-link scheme to verify against the installed version
   (UI Design Principle #3).
8. **Stretch — polish.** Position persistence across reboots, per-session titles in labels,
   configurable colors/size, optional pulse animation on blocked.
9. ✅ **Extension parity — "done" light (decision 014).** *Done 2026-07-06.* The VS Code
   extension now mirrors the bar: a finished-but-unreviewed turn (`idle && detail`) renders at
   full brightness, acknowledged idle is dimmed (`disabledForeground`); click-to-focus also
   acknowledges (app-local `reviewedAt`, keyed by finish time). Recompiled, repackaged the
   `.vsix`, reinstalled — takes effect on the next window reload.

---

## Decisions needed

- **Confirmed event→state mapping** — pending Milestone 1's real-session observations
  (may adjust the doc-sourced names in Current state).
- **Light bar visual design** — ~~orientation (horizontal/vertical)~~ **decided (decision
  015):** now user-toggleable in the settings panel. Remaining: light shape/size, spacing,
  label-on-hover vs always-on.

---

## Recently completed

- **2026-07-06** — **First public release v0.1.0 (decision 024).** Cut the first GitHub
  Release. Committed the pending decision-023 work, rebuilt a fresh
  `ClaudeStatus_0.1.0_aarch64.dmg` (Apple-Silicon-only, unsigned) from the tagged commit,
  tagged `v0.1.0`, and published the Release with the DMG attached. Rewrote
  [README.md](README.md) to lead with the DMG download + accurate macOS-15+/26 Gatekeeper
  steps (`xattr -dr com.apple.quarantine` or "Open Anyway"), keeping `install.sh`
  build-from-source as the Intel/dev path. **Deferred:** code signing + notarization (removes
  the Gatekeeper step); a universal (Intel + ARM) binary; Homebrew cask; marketplace-publish
  the VS Code extension.
- **2026-07-06** — **Settings: bar opacity slider (decision 023).** Added an **Opacity** slider
  (0–100%) to the settings panel. Drives a new `--bar-opacity` CSS variable on `#bar` that fades
  the whole pill together — fill, border, drop-shadow, and backdrop-blur, all scaled via `calc()`
  with multipliers normalized so 82% reproduces the original look. (A first cut varied only the
  fill; barely visible when the bar is minimized to a few lights, since the border/blur dominate
  there — so the chrome now fades too.) Range widened to 0–100 for more travel toward transparent;
  at 0% the pill vanishes and only the lights float. The lights are separate, fully-opaque
  elements, so the signal never fades. Same frontend-only `localStorage`
  (`claudestatus.baropacity`, whole percent) + `applyStyle()` pattern as decision-017; `Reset to
  defaults` restores 82%. Touches `app/src/index.html`, `app/src/styles.css`, `app/src/main.js`.
  Rebuilt + reinstalled via `install.sh` (auto-restart), now live. **Left to verify (live):** drag
  the slider and confirm the whole pill fades smoothly to invisible while the lights stay sharp.
- **2026-07-06** — **Display polish + position persistence + installer auto-restart (decision
  022).** Rebuilt and installed via `install.sh` — now live. (1) **Even padding in vertical mode**:
  `#bar.vertical { padding: var(--bar-pad) }` drops the horizontal-only `+4px` side padding so all
  four sides match (`app/src/styles.css`). (2) **Drag clamp across all monitors + magnetism**:
  `clampToMonitor()` on the window `moved` event bounds the bar to the union bounding box of every
  `availableMonitors()` (slides across shared edges, can't leave the outer edges; center-in-a-gap
  guard pulls it onto the nearest display), with **soft edge magnetism** (`SNAP_LOGICAL = 16`
  logical px, per-monitor scaled) that pins a near edge flush (`app/src/main.js`). (3) **Position
  persistence**: saves the **lights' screen anchor** (`{x,y,scale}`, `claudestatus.pos`) — not the
  window top-left, which depends on settings-panel state — and re-anchors on launch via
  `anchorLightsTo()` over `center: true`, so restarts/rebuilds/reloads no longer move the bar
  (`app/src/main.js`). (First cut saved the window top-left and jumped on Reload because the Reload
  button is inside the panel; fixed.)
  (4) **Reload button** in the settings-panel footer → `window.location.reload()`
  (`app/src/index.html` + CSS). (5) **`install.sh` auto-restart**: if an instance was already
  running, it quits and relaunches the rebuilt app (past the single-instance guard) so rebuilds
  land in one command; first installs still fall through to the manual Gatekeeper-Open steps.
  **Left to verify (live):** position actually restores across the *next* rebuild (nothing was
  saved before this one, so it centered by design); and multi-monitor crossing/magnetism on a real
  multi-display setup.
- **2026-07-06** — **Single-instance guard (decision 020) + faster click-to-focus (decision
  021).** (1) **Fixed two bars running at once** — the installed `/Applications` copy and the
  in-repo dev build were both up, drawing overlapping duplicate bars off the same status dir.
  Root cause: no instance guard. Added `tauri-plugin-single-instance` (release-gated) as the
  first plugin in `run()`; keyed by the shared `com.claudestatus.app` identifier so it catches
  both bundles. **Verified:** from a clean state, launching a second copy (either path) exits
  immediately — 3 rapid launch attempts left exactly one instance. (Observed one transient
  double-instance while rapidly kill/relaunching during the rebuild; it's a narrow stale-socket
  race that self-heals — a dead socket → connection-refused → rebind — confirmed live.) (2)
  **Sped up same-Space window switching** from ~1.15s to ~0.2s: the decision-016 IDE CLI boots a
  Node runtime every click, so `focus_session` now *also* fires a fast `osascript` System Events
  raise (`set frontmost` + `AXRaise` by workspace-root basename) before it. Fast path covers the
  same-Space case; the CLI still fires and covers cross-Space / full-screen. Needs a one-time
  **Accessibility** grant for ClaudeStatus.app (documented as optional in `install.sh`); without
  it the `osascript` no-ops and the CLI alone runs — no regression. Touched
  `app/src-tauri/Cargo.toml`, `app/src-tauri/src/lib.rs` (`raise_window_fast` + guard),
  `install.sh`. Rebuilt and reinstalled to `/Applications`. **Left to verify:** the focus
  speedup live once the user grants Accessibility (re-copying the bundle likely reset its TCC
  grant).
- **2026-07-06** — **Bar light → focus the exact session tab, not just the window (decision
  019).** A bar-light click now lands on the specific Claude *session tab*, solving the
  multiple-sessions-in-one-folder case that window-raise (decision 016) can't. Hybrid: the bar
  still raises the right window via `code/cursor <root>`, and additionally writes
  `~/.claude/status/focus-request.json` `{session_id, requested_at(ms)}`; the per-window
  extension polls it and calls the popup-free in-editor `claude-vscode.editor.open` to reveal
  that session's panel (advances a per-window watermark so each click fires once; seeded at
  `activate` so a stale request isn't replayed on reload). Rejected the `vscode://…open?session=`
  deep link after re-verifying live that it shows a **consent popup on every click** (the old
  "spawns new agents" note was stale — no new agent spawned — but the popup is real). **Verified
  end-to-end:** clicked a session's light from another VS Code window → the ClaudeStatus window
  came forward *and* the exact conversation tab was revealed. Touched `lib.rs`
  (`write_focus_request`, `focus_session` gained a `session_id` arg), `main.js` (passes `s.id`),
  `extension/src/extension.ts` (relay). Extension repackaged/reinstalled (`0.1.2`); packaged app
  rebuilt via `install.sh`. No hook or per-session schema change.
- **2026-07-06** — **Cursor support (decision 018).** Verified (Cursor 3.10.11, via a temp
  Cursor logger + Cursor's own hook logs) that Cursor bridges Claude Code hooks and exposes
  clean payloads (`session_id`, `workspace_roots`, `cursor_version`, `subagent_id`, `Stop.status`).
  Taught `report.sh` to handle Cursor payloads and write an `ide` field; wrote
  [hooks/cursor-setup.mjs](hooks/cursor-setup.mjs) to register the bridge-dropped events natively;
  made the bar's click-to-focus IDE-aware (Rust + JS, compiles clean). Unit-tested against real
  captured payloads (VS Code regressions intact). Left the temporary Cursor logger uninstalled.
  **Not yet live-verified end-to-end** (needs a folder-open Cursor run — Cursor runs no hooks in
  a folder-less window) and the app still needs a rebuild + `install.rs` port to self-install the
  Cursor hooks.
- **2026-07-06** — **Settings: size + padding + per-state colors, and keep-on-screen (decision
  017).** Added to the panel: a **size** slider (dot size, 8–24px), a **padding** slider
  (wrapper padding around the lights, 2–20px), **per-state color** pickers (native
  `<input type="color">` for running/blocked/done/idle/error — confirmed working live on the
  NSPanel), and a "Reset to defaults." Refactored the dot geometry, wrapper padding, and state
  colors in `styles.css` to CSS variables on `#bar`, glow derived from the base color via
  `color-mix`; JS sets them from `localStorage` (`claudestatus.dotsize`/`.barpad`/`.colors`),
  same frontend-only pattern as orientation. Also reworked how the panel opens near a
  screen edge so the **lights stay put** and the panel grows toward the screen middle: on
  toggle we anchor the `#lights` screen position, pick the direction (panel above when the bar
  is in the bottom half via `column-reverse`, below in the top half; grows left/right toward
  center via `align-items`), then reposition the window so the lights land back on the anchor —
  they never move on open or close. (Replaced the earlier `keepOnScreen` inward-clamp, which
  moved the lights; its `currentMonitor` call also silently threw — v2 monitor APIs are
  module-level functions, not window methods.) Anchoring runs only on the toggle, so dragging a
  panel-open bar isn't snapped back. **Left to do:** `./install.sh` to update the packaged app
  once confirmed. Frontend only; dev instance compiles + runs clean.
- **2026-07-06** — **Fixed bar click-to-focus opening new windows (decision 016).** Root cause
  (verified live): `open -a "Visual Studio Code" <cwd>` spawns a *new* window when the target
  is a full-screen window on another macOS Space — the app's core use case. Replaced it with
  the IDE's own CLI (`code`/`cursor <root>`), which resolves folder→window internally (Space-
  aware, no duplicate window, no Accessibility permission). Workspace root resolved from
  `~/.claude/ide/*.lock` so a subfolder `cwd` still focuses the right window. Rejected an
  AppleScript window-raise (System Events can't see full-screen windows on inactive Spaces —
  observed) and the `vscode://` deep link (routes through create/resumeSession + consent
  prompt). Rebuilt + reinstalled the app. **User to verify** the cross-Space full-screen focus.
  Still window- not tab-granular (multiple sessions in one folder focus the same window).
- **2026-07-06** — **Settings panel + orientation toggle (decision 015).** Added the first
  settings surface: **right-click the bar** toggles an inline panel below the lights (window
  grows to fit, shrinks back on close; pill radius rounds to 15px while open). First setting is
  **orientation** — a horizontal/vertical segmented toggle that flips `#lights` between a row
  and a column via a `.vertical` class on `#bar`; the existing content-hugging auto-resize
  reshapes the window, so no other geometry changed. Choice persisted in webview `localStorage`
  (`claudestatus.orientation`), app-local like `reviewedAt` — no hook/schema change. Frontend
  only (`index.html`, `styles.css`, `main.js`); dev instance compiles + launches clean.
  **Unverified by hand:** right-click routing on the non-activating NSPanel and the vertical
  render — confirm on the running dev bar, then rebuild the packaged app (`./install.sh`).
- **2026-07-06** — **"Done" vs "idle" light split (decision 014).** Split the single gray idle
  light into **done** (a turn just finished, output not yet reviewed — steady bright-white,
  no pulse) and **idle** (acknowledged — dim gray). Reviewed-tracking is app-local: clicking
  a light acknowledges it (and focuses the session as before), keyed by the finish time so the
  next finished turn re-lights automatically. Discriminates a finished turn from a fresh idle
  via `idle && detail != ""` — no hook or schema change. Unit-tested the lifecycle; rebuilt +
  reinstalled the app. **Also mirrored in the VS Code extension** — status-bar item at full
  brightness for `done`, dimmed for acknowledged idle, click-to-focus acknowledges; recompiled,
  repackaged the `.vsix`, reinstalled (effective on next window reload).
- **2026-07-06** — **Error signal + noise fixes (decision 013).** Red is now `StopFailure`
  only (confirmed live that tool failures produce only `PostToolUseFailure`, never
  `StopFailure`); `PostToolUseFailure` is calibration-logged but no longer flips the light.
  Added the `CLAUDESTATUS_IGNORE` env opt-out for programmatic Claude calls (ApplicationBot's
  question-classification sessions were showing as fleeting lights). Propagated the hook to
  all four copies (repo / live / app-embedded / extension-bundled).
- **2026-07-05** — **Milestone 6 complete.** Built the VS Code extension (`extension/`):
  per-window status-bar items reading the status files scoped by workspace, hover detail,
  subagent `×N`, and click-to-focus via `claude-vscode.editor.open` (found by reading Claude
  Code's own URI handler — avoids the consent prompt). Packaged `.vsix`, installed via the
  `code` CLI, verified live. Decision 012.
- **2026-07-05** — **Milestone 5 complete.** Ported the hook installer to Rust
  ([app/src-tauri/src/install.rs](app/src-tauri/src/install.rs), release-gated), embedded
  `report.sh` via `include_str!`, and bundled `ClaudeStatus.app` + `.dmg`. Installed to
  `/Applications` and verified the app self-installs all 11 hooks on launch (deduped, backed
  up, non-clobbering). Wrote [install.sh](install.sh) + [README.md](README.md). Retired the
  dev server; the packaged app is the running bar now. Decision 011.
- **2026-07-05** — **M4 features:** click-to-focus (window focus via `open -a`, after the
  `vscode://` deep link proved to spawn new agents + a popup); dead-session pruning (2h,
  self-healing) replacing heartbeat-dimming; hover tooltip with task + activity; subagent
  count badge (decision 009 — verified `SubagentStart/Stop` carry `agent_id`/`agent_type`
  under the parent session; subagent tool calls aren't attributable, so lifecycle-only).
- **2026-07-05** — **Milestone 3 complete.** Installed Rust; scaffolded + customized the
  Tauri v2 app into a non-activating NSPanel overlay that floats over full-screen apps
  (decision 008, after ruling out always-on-top / native NSWindow level / accessory-only).
  Fixed an invisible-window bug (auto-resize measured before paint → 0-size). Renders live
  status dots from the M2 status files. Verified floating over full-screen VS Code.
- **2026-07-05** — **Milestone 2 complete.** Built + validated the signal layer: `report.sh`
  (per-session status files, decision 007) and the `setup.mjs` installer. Unit-tested all
  branches, replayed the 160 real M1 events correctly, installed live and confirmed real-time
  status writes. Logged decision 007 (per-session store).
- **2026-07-05** — **Milestone 1 complete.** Verified the event→state mapping on real
  sessions (Claude Code 2.1.201): blocked = `PermissionRequest` (not `Notification`), error
  signal is the soft spot (interim `PostToolUseFailure`), hooks are session-level, windows
  key on workspace folder via `~/.claude/ide/*.lock`. Uninstalled the broad logger; settings
  clean. Full write-up: [DECISIONS.md](DECISIONS.md) #006. Also researched window scoping →
  auto "this window" via the extension (decision 006).
- **2026-07-05** — Milestone 1 kickoff: scaffolded the repo (`hooks/`, `logs/`, `app/`,
  `.gitignore`, git init), built the temporary event logger + idempotent installer.
- **2026-07-05** — Decided the install model (decision 005): global hooks = install once per
  machine, delivered via a self-installing app **and** an optional VS Code extension.
- **2026-07-05** — Chose the architecture: hooks → shared JSON status file → Tauri
  always-on-top window (decisions 001–004). Adapted the project docs (CLAUDE.md,
  DECISIONS.md, NEXT_STEPS.md) from the imported best-practices templates to ClaudeStatus.

# NEXT_STEPS.md — Living Build Queue

> Read this at the start of every session to pick up where the last one left off.
> Update it at the end of every session where anything changed (Agent Guideline #10).

---

## Current state

- **Antigravity IDE support shipped, but UNVERIFIED (decision 033).** The bar now installs
  hooks into `~/.gemini/config/hooks.json` and renders `ide:"antigravity"` lights. This
  landed in `3195f11` without a decision entry or an observed event log; 033 documents it
  retroactively. **Its event names, payload fields, hook-config schema, and transcript path
  are all guesses until confirmed against a live Antigravity session (Guideline #4)** — see
  "Now" below. Known gaps: no permission/failure event is registered, so Antigravity lights
  can only be green/gray (never orange/red), and the `PostInvocation` mapping is dead code.
  Fixed on the way in: the transcript read is now gated on the antigravity host — ungated it
  was spawning `python3` over the real Claude transcript on **every Claude prompt submit**
  (137 ms → 39 ms per turn, ~98 ms saved; the result was always discarded).
- **Codex open/close lifecycle fixed (decision 032).** Verified against the installed
  `openai.chatgpt` extension binary and the `openai/codex` source: Codex emits **no signal**
  on conversation open or close (no `SessionEnd` hook; `SessionStart` deferred to the first
  turn; DB timestamps advance only on turn starts) — a dot at first prompt is the earliest
  Codex allows. Fixes shipped: installers pass an explicit `codex` arg to `report.sh`
  (payloads are Claude-shaped, the #029 sniffing heuristics never fired — live sessions were
  mislabeled `ide:"vscode"`); Codex lights expire after **10 min** idle instead of 2h, drop
  instantly when no `codex` process is alive, and skip archived threads; click-to-focus now
  targets the VS Code window (`open -a Codex` was a no-op — no such app). Rebuilt + reinstalled
  via `./install.sh`; `~/.codex/hooks.json` rewritten with the arg. **Watch for:** an
  open-but-idle Codex conversation's dot also fades at 10 min (reappears on its next turn) —
  revisit the window if that annoys in practice.
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
  (1) `/Applications/AgentStatus.app` — floating always-on-top bar of all sessions; self-
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
AgentStatus/
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
`~/.claude/status/sessions/<session_id>.json` (dir overridable via `$AGENTSTATUS_DIR`):
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
   dead-session pruning (instant on IDE-window close via the lock files — decision 027 — with a
   2h idle timer as backstop, replacing heartbeat-dimming);
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
   `/Applications/AgentStatus.app` and running. *Deferred:* launch-at-login is a manual
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
10. **Verify Antigravity against a live session (decision 033) — Guideline #4.** The whole
    integration is built on unobserved assumptions. Run a real Antigravity session with the
    hooks installed and confirm, in order: (a) the hooks actually fire from the `agentstatus`
    key in `~/.gemini/config/hooks.json`; (b) the event names (`PreInvocation`, `Stop`, …);
    (c) the payload fields (`workspacePaths[]`, `toolCall.name`, `toolCall.args.*`); (d) the
    transcript path and its `USER_INPUT` / `<USER_REQUEST>` shape — the
    `_full.jsonl`-then-`.jsonl` fallback is a guess. Then decide whether Antigravity exposes
    a permission-request or turn-failure event; without one its lights can never go
    orange/red, which quietly breaks UI Principle #2 for that host.
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

- **2026-07-15** — **Released v0.4.0.** Bumped `0.3.0 → 0.4.0` (`tauri.conf.json`,
  `Cargo.toml`, `package.json`, lockfiles, README DMG name), rebuilt
  `AgentStatus_0.4.0_aarch64.dmg`, installed/relaunched `/Applications/AgentStatus.app`, and
  tagged/published `v0.4.0` from `development`. Contents: the Codex lifecycle fix (decision
  032), Antigravity as a fourth host (decision 033 — **unverified against a live install**,
  see item 10), the pill backdrop-filter clipping fix, the Antigravity transcript-read gate
  (~98 ms/turn off every Claude prompt submit), and the latched hover-scale fix.
- **2026-07-15** — **Fixed the hover scale latching after a light click.** Clicking a light
  focuses another app's window, so the pointer leaves the bar without WebKit delivering a
  `mouseleave` — `:hover` stayed latched and the dot sat at `scale(1.18)` indefinitely. A
  `#bar.nohover` class added on click neutralizes the hover transform and is removed on the
  next `mousemove`, when the pointer's real position is known again.
- **2026-07-15** — **Documented Antigravity support (decision 033) and fixed the transcript
  read it added.** The Antigravity host shipped undocumented in `3195f11`; 033 records its
  hook schema (`agentstatus` key in `~/.gemini/config/hooks.json`), event→state mapping,
  payload differences, and pruning/focus behavior, and flags the whole thing as unverified
  against a live install. Fixed: the transcript read was gated on the event name alone, and
  `UserPromptSubmit` is Claude's event — so every Claude prompt submit walked the fallback
  chain into the real Claude transcript and ran `python3` over it (137 ms → 39 ms per turn
  once gated on `ide == antigravity`; ~98 ms saved). The parse was always discarded: it scans
  for `USER_INPUT` records that Claude transcripts don't contain, and jq prefers the payload
  `.prompt` regardless. Smoke-tested both hosts against a temp status dir.

- **2026-07-09** — **Fixed the faint rectangle around the pill on light backgrounds.** The pill's
  `backdrop-filter: blur()` sat on `#bar` alongside `border-radius: 999px`; WebKit does not clip a
  backdrop-filter to the element's (or an ancestor's) rounded corners, so the blurred backdrop
  leaked to the bounding box and showed as a lighter rectangle over non-uniform/light backgrounds.
  `overflow: hidden` on a parent did not clip it either. Moved the frosted pill (fill + border +
  blur) onto a `#pill` layer behind the lights (`z-index: -1`, `pointer-events: none`) and clipped
  the blur with `clip-path: inset(0 round 999px)` — the one thing WebKit does honor — with a
  `.settings-open` override to `15px` to match the panel corners; the drop shadow stays on `#bar`
  so `clip-path` doesn't clip it away. `--bar-opacity` behavior and the badges/hover-scale that
  spill outside the pill are unchanged. Verified in a dev build over a white background: the
  square-cornered halo is gone, leaving only the intended rounded shadow. Ships on next rebuild.
- **2026-07-09** — **Fixed Codex open/close lifecycle (decision 032).** Established (from the
  installed binary + `openai/codex` source) that Codex has no conversation open/close signal at
  all; replaced the dead payload-sniffing heuristics with an explicit `codex` arg from both
  installers, shortened Codex light expiry to 10 min idle (user-approved) with instant drop when
  no `codex` process runs, excluded archived threads from the #031 fallback, and pointed
  click-to-focus at the VS Code window hosting the thread. Rebuilt/reinstalled the app;
  smoke-tested `report.sh` tagging for codex/claude/cursor payloads.
- **2026-07-09** — **Renamed ClaudeStatus → AgentStatus (decision 030).** The product name now
  matches the broader agent scope: Claude Code, Codex, and Cursor. Updated app bundle/product
  names, Tauri identifier/window title, docs, installer paths, extension metadata/command ids,
  localStorage keys, hook backup suffixes, and release asset naming. Kept migration support for
  legacy `CLAUDESTATUS_DIR` / `CLAUDESTATUS_IGNORE`, and the installer removes a prior
  `/Applications/ClaudeStatus.app` while installing `/Applications/AgentStatus.app`.
- **2026-07-09** — **Released v0.3.0.** Promoted the Codex-compatible lightbar build to the
  next public release, then repointed it to the branded AgentStatus build with the live-Codex
  fallback fix: rebuilt `AgentStatus_0.3.0_aarch64.dmg`, installed/relaunched
  `/Applications/AgentStatus.app` locally, and moved the `v0.3.0` tag/release to the fixed commit.
  Headline: AgentStatus tracks Claude Code, Codex, and Cursor sessions from the shared lightbar,
  and active Codex work renders green even when hooks are not yet trusted/loaded.
- **2026-07-09** — **Codex compatibility (decision 029).** AgentStatus now installs the shared
  `report.sh` into Codex user hooks at `~/.codex/hooks.json` as well as Claude's
  `~/.claude/settings.json`. Codex registration uses only the currently documented Codex hook
  events, while Claude/Cursor keep their existing fuller event set. The reporter accepts Codex
  thread/conversation ids, falls back to the hook process cwd, writes `ide:"codex"`, and the app
  skips IDE-lock pruning for Codex sessions. Clicking a Codex light opens `Codex.app`. Verified
  against the official Codex manual (fetched 2026-07-09), `bash -n`, `node --check`,
  `cargo check`, and temp-dir hook smoke tests.
- **2026-07-07** — **Quit button in settings (decision 028).** The accessory app (no Dock icon,
  no app menu) now has an in-UI way to quit: a **Quit** button in the settings-panel footer wired
  to a new `quit_app` Tauri command (`app.exit(0)`), red-tinted on hover. New in
  `app/src-tauri/src/lib.rs` (`quit_app` command + handler), `app/src/index.html` (`#quit-btn`),
  `app/src/main.js` (click → `invoke("quit_app")`), `app/src/styles.css` (shared footer style +
  red hover). `cargo check` clean. **Left:** rebuild + reinstall to exercise it in the packaged app.
- **2026-07-07** — **Stale-light fix: prune on IDE-window close (decision 027).** Lights no
  longer linger up to 2h after a session's IDE window is gone. `list_sessions` now builds the set
  of **live workspace folders** from `~/.claude/ide/*.lock` (skipping locks whose owning `pid` is
  dead — force-quit/crash) and deletes any session whose `cwd` maps to no live folder (empty `cwd`
  = anonymous ghost → matches nothing → pruned), instantly. Purely additive: the 2h idle timer
  (#004) is unchanged and still covers a superseded session sharing a live window's lock. Gated so
  an empty live-lock set (no-IDE machine / bad read) skips lock-pruning entirely. New in
  `app/src-tauri/src/lib.rs` (`pid_alive`, `live_workspace_folders`, `cwd_is_live`) + `libc`
  macOS-target dep. Verified against live state (both empty-`cwd` Cursor ghosts flagged for prune,
  all real sessions kept). **Left:** rebuild + reinstall the app (running copy predates this), then
  confirm by closing a window and watching its light vanish within a poll.
- **2026-07-07** — **Released v0.2.0.** Cut the second GitHub Release (follows the decision-024
  unsigned Apple-Silicon DMG pattern): bumped `0.1.0 → 0.2.0` (`tauri.conf.json`, `Cargo.toml`,
  `package.json`, README DMG name), rebuilt `AgentStatus_0.2.0_aarch64.dmg` via `install.sh`,
  merged `development → main`, tagged `v0.2.0`, and published the release with the DMG. Headline
  features over v0.1.0: **menu-bar mode** (decision 026) and the **sort** toggle (decision 025).
- **2026-07-06** — **Menu-bar mode: floating ↔ macOS menu bar toggle (decision 026).** The bar
  can now run in the **macOS menu bar** as well as floating. A `tray-icon` `NSStatusItem` shows
  the lights as an **image the webview renders** each poll (offscreen `<canvas>` reusing
  `displayState()`/`currentColors()` → RGBA → Rust `set_tray_image`, pushed only when a
  states+colors+condense signature changes), with a **Condense** option that draws one summary dot
  (`error>blocked>done>running>idle`). Clicking the item drops the *same* NSPanel down as a
  **popover** (`toggle_popover`), so per-light tab-focus (#019), hover, and badges work unchanged.
  Toggle is a **Mode** segmented control in the settings panel (`localStorage`
  `agentstatus.mode`/`.menubarcondense`); menu-bar mode **forces horizontal** (a vertical popover
  off the bar looks wrong) and hides the Orientation control. Amends decision 003 (menu bar is now
  an optional mode). Two macOS gotchas found + fixed live: **tray ops must run on the main thread**
  (`run_on_main_thread`; off-main they silently no-op'd, so the panel hid with no tray — plus a
  fallback that never hides the panel when the tray is absent), and the **icon must be forced
  non-template** (`set_icon_as_template(false)` re-asserted per image, else macOS draws it as a
  black alpha-mask silhouette, swallowing the colors). Touches `app/src-tauri/src/lib.rs`,
  `app/src-tauri/Cargo.toml` (`tray-icon` feature), `app/src/main.js`, `index.html`, `styles.css`.
  Shipped via `install.sh` (release, single-instance; auto-restarted). **Known limits:** the menu
  bar auto-hides in full-screen apps (so floating still owns the over-full-screen case — it's a
  per-situation toggle, not a replacement); can't force the item rightmost (macOS reserves the
  right edge; ⌘-drag once to pin it out from under the notch). **Left to verify with the user:**
  colored dots visible/findable in the menu bar, popover opens horizontal, click-to-focus from it.
- **2026-07-06** — **Settings: light sort toggle (decision 025).** Added a **Sort** segmented
  control to the settings panel: **Window** (default — group sessions by their workspace folder,
  sorting by full `cwd` path so subfolders cluster with their root and same-basename windows stay
  distinct) vs **Urgency** (attention states first — `error → blocked → done → running → idle`).
  Answers "sort by what window a session is in"; since hooks expose no true per-window id
  (decision 006), a window is proxied by `cwd` and two windows on the *same* folder merge (user
  accepted this limit). Frontend-only: sorting moved into `tick()`, persisted in `localStorage`
  (`agentstatus.sort`), same pattern as orientation — no hook/schema change. Touches
  `app/src/index.html`, `app/src/main.js`. Rebuilt + reinstalled via `install.sh`. **Left to
  verify (live):** open the panel, toggle Window/Urgency, confirm the lights reorder (and, with
  ≥2 sessions in one folder + others elsewhere, that same-folder lights sit adjacent).
- **2026-07-06** — **First public release v0.1.0 (decision 024).** Cut the first GitHub
  Release. Committed the pending decision-023 work, rebuilt a fresh
  `AgentStatus_0.1.0_aarch64.dmg` (Apple-Silicon-only, unsigned) from the tagged commit,
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
  (`agentstatus.baropacity`, whole percent) + `applyStyle()` pattern as decision-017; `Reset to
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
  persistence**: saves the **lights' screen anchor** (`{x,y,scale}`, `agentstatus.pos`) — not the
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
  first plugin in `run()`; keyed by the shared `com.agentstatus.app` identifier so it catches
  both bundles. **Verified:** from a clean state, launching a second copy (either path) exits
  immediately — 3 rapid launch attempts left exactly one instance. (Observed one transient
  double-instance while rapidly kill/relaunching during the rebuild; it's a narrow stale-socket
  race that self-heals — a dead socket → connection-refused → rebind — confirmed live.) (2)
  **Sped up same-Space window switching** from ~1.15s to ~0.2s: the decision-016 IDE CLI boots a
  Node runtime every click, so `focus_session` now *also* fires a fast `osascript` System Events
  raise (`set frontmost` + `AXRaise` by workspace-root basename) before it. Fast path covers the
  same-Space case; the CLI still fires and covers cross-Space / full-screen. Needs a one-time
  **Accessibility** grant for AgentStatus.app (documented as optional in `install.sh`); without
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
  end-to-end:** clicked a session's light from another VS Code window → the AgentStatus window
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
  `color-mix`; JS sets them from `localStorage` (`agentstatus.dotsize`/`.barpad`/`.colors`),
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
  (`agentstatus.orientation`), app-local like `reviewedAt` — no hook/schema change. Frontend
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
  Added the `AGENTSTATUS_IGNORE` env opt-out for programmatic Claude calls (ApplicationBot's
  question-classification sessions were showing as fleeting lights). Propagated the hook to
  all four copies (repo / live / app-embedded / extension-bundled).
- **2026-07-05** — **Milestone 6 complete.** Built the VS Code extension (`extension/`):
  per-window status-bar items reading the status files scoped by workspace, hover detail,
  subagent `×N`, and click-to-focus via `claude-vscode.editor.open` (found by reading Claude
  Code's own URI handler — avoids the consent prompt). Packaged `.vsix`, installed via the
  `code` CLI, verified live. Decision 012.
- **2026-07-05** — **Milestone 5 complete.** Ported the hook installer to Rust
  ([app/src-tauri/src/install.rs](app/src-tauri/src/install.rs), release-gated), embedded
  `report.sh` via `include_str!`, and bundled `AgentStatus.app` + `.dmg`. Installed to
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
  DECISIONS.md, NEXT_STEPS.md) from the imported best-practices templates to AgentStatus.

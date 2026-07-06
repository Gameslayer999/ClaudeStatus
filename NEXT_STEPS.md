# NEXT_STEPS.md — Living Build Queue

> Read this at the start of every session to pick up where the last one left off.
> Update it at the end of every session where anything changed (Agent Guideline #10).

---

## Current state

- **Milestones 1–5 done. Shipping as a packaged app.** `/Applications/ClaudeStatus.app` is
  built and running; it self-installs its hooks on launch (→ `~/.claude/status/report.sh`,
  registered in `~/.claude/settings.json`). Features live: four-state lights, hover tooltip
  (task + activity), click-to-focus, subagent count badges, floats over full-screen, drag +
  position-memory, dead-session pruning. Next: **Milestone 6 (VS Code extension)** and any
  remaining polish / error-signal calibration. Details of each milestone below.
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
   **click-to-focus** (click a light → `open -a "Visual Studio Code" <cwd>` focuses that
   window; drag handle = pill padding); dead-session pruning (2h, replaced heartbeat-dimming);
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

6. **Milestone 6 — VS Code extension (decisions 005, 006).** Marketplace-distributed
   extension: one-click install that ensures the global hooks are present and launches the
   bar; **auto "this window" scoping** — shows only the sessions whose `cwd` is within the
   extension host's own `workspaceFolders` (the v1 window-scoping mechanism); plus
   click-to-focus a specific session's tab (the one integration the app can't do from
   outside).
7. **(Promoted into M4) — click-to-focus from the bar.** Clicking a light focuses that
   session's window. Approach: a Rust command opens a `vscode://` deep link
   (`tauri_plugin_opener` is already a dep), with a `code <cwd>` fallback to at least focus the
   workspace window. Exact deep-link scheme to verify against the installed version
   (UI Design Principle #3).
8. **Stretch — polish.** Position persistence across reboots, per-session titles in labels,
   configurable colors/size, optional pulse animation on blocked.

---

## Decisions needed

- **Confirmed event→state mapping** — pending Milestone 1's real-session observations
  (may adjust the doc-sourced names in Current state).
- **Light bar visual design** — orientation (horizontal/vertical), light shape/size,
  spacing, label-on-hover vs always-on. Decide once Milestone 4 starts; log in DECISIONS.md.

---

## Recently completed

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

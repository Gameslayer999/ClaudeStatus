# DECISIONS.md — Architecture & Tooling Decisions

> Every significant choice — architecture, tooling, the status-file schema, the
> event→state mapping, the display stack, or a reversal of a prior decision — is logged
> here with its context, the options considered, the choice, and the reasoning
> (Agent Guideline #9). Code captures *what* the system does; this file captures *why*.

---

## Decision Index

| # | Date | Decision | Status |
|---|------|----------|--------|
| 001 | 2026-07-05 | Status signal source: Claude Code hooks (not transcript polling / no public API) | Accepted |
| 002 | 2026-07-05 | Signal transport: hooks write a shared JSON status file (not a local server) | Accepted |
| 003 | 2026-07-05 | Display layer: Tauri borderless always-on-top window (not SwiftUI / Electron / menu bar / VS Code status bar) | Accepted |
| 004 | 2026-07-05 | Session identity: key by `session_id`, label by project folder; stale detection via heartbeat timestamp | Accepted |
| 005 | 2026-07-05 | Install model: global hooks (install once per machine) delivered via a self-installing app **and** an optional VS Code extension | Accepted |
| 006 | 2026-07-05 | Verified event→state mapping on Claude Code 2.1.201 (blocked = `PermissionRequest`, not `Notification`); window scoping = workspace folder via `~/.claude/ide/*.lock`, auto "this window" is the extension's job | Accepted |
| 007 | 2026-07-05 | Status store: one file per session (`~/.claude/status/sessions/<id>.json`), not a single shared JSON — refines #002 | Accepted |
| 008 | 2026-07-05 | macOS overlay: non-activating NSPanel (via `tauri-nspanel`) + Accessory app — the only way to float over other apps' full-screen spaces | Accepted |
| 009 | 2026-07-05 | Hover tooltip (task + activity) and subagent tracking (count badge) — subagents tracked by SubagentStart/Stop lifecycle only (their tool calls aren't attributable) | Accepted |
| 010 | 2026-07-05 | Subagent storage: one marker file per subagent (`sessions/<id>.subagents/<agent_id>`), not a field in the session JSON — parallel subagents were racing the shared file | Accepted |
| 011 | 2026-07-05 | Packaging: self-installing app — bundles the hook (`include_str!`), writes it to `~/.claude/status/report.sh` and registers it on launch (release builds only); ships `.app` + `.dmg` + `install.sh` | Accepted |

---

## Decisions

## 001 — Status signal source: Claude Code hooks

**Date:** 2026-07-05
**Status:** Accepted

**Context:** The tool needs to know, in near-real-time, the live state of each Claude Code
session (running / blocked / idle / error). We evaluated how to obtain that state from the
outside.

**Options considered:**
| Option | Pros | Cons |
|---|---|---|
| Claude Code **hooks** | Official, event-driven, push-based; payload includes `session_id`, `cwd`, `transcript_path`; fires exactly on the lifecycle transitions we care about | Event names/payloads are version-dependent and must be verified |
| Poll session **transcript `.jsonl`** files under `~/.claude/projects/` | Always present; no config needed | Internal, unstable format; polling lag; inferring "blocked vs running" from transcript tails is fragile |
| A **public API / IPC / MCP** into a running session | Would be cleanest if it existed | No such external status interface is exposed |

**Decision:** Use Claude Code hooks as the primary signal source. Transcripts may be used
only for a last-activity timestamp if needed, never as the state source.

**Reasoning:** Hooks are the only push-based, officially-supported signal that maps
directly onto the four states, and their payload already carries the fields we need to
identify a session. The transcript format is explicitly internal and unstable; building
state inference on it would be brittle. See Agent Guideline #4 — the exact event set is
version-dependent and must be confirmed against the installed version (build Milestone 1).

## 002 — Signal transport: shared JSON status file

**Date:** 2026-07-05
**Status:** Accepted

**Context:** Hooks (short-lived shell commands) need to communicate each session's current
state to the long-lived display app.

**Options considered:**
| Option | Pros | Cons |
|---|---|---|
| Hooks write a **shared JSON file** (`~/.claude/status/sessions.json`), app watches it | Dead simple; no server; survives app restarts; state persists between runs; hooks stay trivial and fast | Needs atomic writes to avoid torn reads; slightly less instant than a socket |
| Display app runs a **local HTTP/socket server**; hooks POST events | Real-time; clean push | App must always be running or events are lost; hooks now depend on the app being up (violates "hooks must never block/fail" if the app is down) |

**Decision:** Hooks write session state to a shared JSON file keyed by `session_id`; the
Tauri app watches the file for changes.

**Reasoning:** A file decouples the hook from the app's liveness — a core requirement, since
hooks run inside the user's real sessions and must never block or fail if the display app
isn't running (Agent Guideline #3). It also gives us free persistence across app restarts.
Torn reads are handled with atomic write-and-rename in the hook. A server buys real-time
delivery we don't need for a human-glanceable light and adds a failure mode we explicitly
want to avoid.

## 003 — Display layer: Tauri borderless always-on-top window

**Date:** 2026-07-05
**Status:** Accepted

**Context:** The user wants a small, freely-positionable, always-on-top bar of lights. This
rules out rendering inside VS Code (its extension surfaces — status bar, docked panels —
can't float over the screen). The display is therefore a standalone app.

**Options considered:**
| Option | Pros | Cons |
|---|---|---|
| **Tauri** (Rust shell + web UI) | Tiny (~3–5MB); true borderless always-on-top + drag; web UI makes lights trivial to style/animate; cross-platform later | Rust toolchain setup |
| **Native SwiftUI** (`NSPanel`) | Most Mac-native and lightest; best always-on-top/menu-bar behavior | Swift-only; macOS-only; more UI code |
| **Electron** | Easiest if web-first; huge ecosystem | ~150MB + heavy RAM — overkill for a light bar |
| **VS Code status bar** | No separate app | Not floating/positionable, in-editor only — fails the core ask |
| **Menu bar app** (SwiftBar/xbar) | Zero UI code | Not a repositionable bar placed anywhere on screen |

**Decision:** Build the display as a Tauri app: a borderless, always-on-top, drag-to-position
window that watches the status file and renders one colored light per session.

**Reasoning:** Tauri is the only option that hits the exact form factor (floating,
positionable, tiny) while keeping the UI easy to build and style in web tech, and leaves the
door open to non-macOS later. SwiftUI is a strong lighter-weight alternative but macOS-only
and more UI code; Electron is too heavy; the in-editor options don't meet the "position it
anywhere" requirement.

## 004 — Session identity: `session_id` key, folder label, heartbeat staleness

**Date:** 2026-07-05
**Status:** Accepted

**Context:** Each light must correspond to one session, be labeled so the user can tell
sessions apart, and disappear when a session ends — including unclean deaths (VS Code
force-quit) where no shutdown event fires.

**Options considered / findings:**
- No Claude Code or VS Code API maps a session to a specific **editor tab**, so a light
  cannot be tied to a literal tab. `session_id` is 1:1 with a session and is stable across
  all of that session's hook events, so it is the natural key.
- Multiple sessions can share a `cwd`; the folder name alone doesn't disambiguate. Label
  by project folder (plus a short session title if available) and rely on `session_id` as
  the unique key.
- A clean `SessionEnd` event can't be relied on for shutdown; force-quit skips it.

**Decision:** Key each light by `session_id`. Label it by the `cwd`'s project folder name
(plus session title when available). Write a heartbeat timestamp on every hook, and have
the display treat a session with no update for N minutes as stale — dimming or removing its
light rather than leaving a live-colored light on a dead session.

**Reasoning:** `session_id` is the only stable, unique per-session identifier available
from outside. A heartbeat is required because we cannot depend on a shutdown event, and a
stale/lying light is worse than no light (UI Design Principle #4).

## 005 — Install model: global hooks via self-installing app + VS Code extension

**Date:** 2026-07-05
**Status:** Accepted

**Context:** The user wants installation to be as close to one click as possible, framed as
"set it up in another project or VS Code window with one click." Key finding while building
the Milestone 1 logger: hooks registered in the user's **global** `~/.claude/settings.json`
take effect **immediately, in already-running sessions**, across every project and VS Code
window. So status tracking is inherently machine-wide — there is nothing to install
per-project or per-window. The real question is how to package the single, once-per-machine
install.

**Options considered:**
| Option | The "one click" | Pros | Cons |
|---|---|---|---|
| Self-installing app | Open the app once (or auto-launch at login) | App writes the global hooks + creates the status file on first run; genuinely one action; works everywhere by construction | Install logic lives in the app |
| VS Code extension | Install from the marketplace | Familiar channel; auto-starts with VS Code; enables precise click-to-focus of a specific tab | Can't *be* the floating bar; second codebase; redundant per-window since hooks are global |
| Both | Either | Marketplace reach + tight integration **and** the floating bar | Most work; two artifacts to maintain |
| Script only | `curl \| bash` / one command | Trivial now | Not literally one-click; defers packaging |

**Decision:** Build toward **both**: a self-installing Tauri app as the core floating bar
(installs global hooks on first launch, optional launch-at-login), plus an optional VS Code
extension that offers marketplace install and click-to-focus a specific session's tab. A
one-command script is the interim installer until the app hosts the install logic.

**Reasoning:** Because hooks are global, a single install already covers every project and
window — so the app model delivers the "works everywhere" goal by construction, and opening
the app is the one click. The extension adds a familiar distribution channel and the one
integration the app can't do from outside (focusing a specific VS Code tab). The interim
script keeps us unblocked before packaging exists (Milestone 5). Both share the same hook
installer and status-file contract, so the second artifact is mostly a distribution shell,
not a parallel implementation.

## 006 — Verified event→state mapping (Milestone 1)

**Date:** 2026-07-05
**Status:** Accepted
**Evidence:** Claude Code **2.1.201** (VS Code extension), observed live via the temporary
broad logger across the ClaudeStatus + ApplicationBot windows (`logs/events.log`).

**Context:** Decision 001 planned the event→state mapping from docs, flagged as
version-dependent and requiring confirmation (Agent Guideline #4). Milestone 1 ran a logger
on real sessions to confirm which events actually fire and with what payload.

**Verified event → state mapping:**
| State | Light | Fires on (confirmed) | Confidence |
|---|---|---|---|
| running | 🟢 | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | High — observed |
| blocked | 🟠 | `PermissionRequest` | High — observed |
| idle | ⚪ | `Stop`, `SessionStart` | High — observed |
| error | 🔴 | `PostToolUseFailure` (interim) | **Low** — noisy; see below |
| (remove) | — | `SessionEnd` | High — observed |

**Payload facts (this version):**
- Common fields on every event: `session_id`, `cwd`, `hook_event_name`. `transcript_path`,
  `prompt_id`, `permission_mode` appear on most but **not all** (`Stop` carries only
  `session_id` + `cwd`). So key on `session_id`; derive the window from `cwd`.
- `SessionStart` has `source` (startup/resume/clear/compact); `SessionEnd` has `reason`.
- `PermissionRequest` carries `tool_name` — it fires for **both** tool-permission prompts
  **and** `AskUserQuestion` (tool_name = "AskUserQuestion"), even in `bypassPermissions`
  mode. So "blocked" = "Claude needs the user," and `tool_name` distinguishes a question
  from a tool approval. There is **no** "permission resolved" event — the bar infers
  unblocked from the next event (`PreToolUse`/`Stop`).
- `PostToolUseFailure` carries `error`, `is_interrupt`, `duration_ms`, `tool_response`.

**Corrections to decision 001's assumptions:**
1. **Blocked is `PermissionRequest`, not `Notification`.** `Notification` never fired;
   `Elicitation`, `StopFailure`, `PermissionDenied`, `SubagentStart/Stop`, `Pre/PostCompact`
   also did not fire in this run.
2. **Error is the soft spot.** The only failure event seen was `PostToolUseFailure`, and the
   one captured was an incidental shell non-zero exit that the turn recovered from — i.e.
   tool failures are noisy and do **not** imply a session error. A clean red wants a
   turn-level `StopFailure` (documented but not yet observed). *Interim:* treat
   `PostToolUseFailure` with `is_interrupt == false` as red, and refine once a real
   `StopFailure` is observed. → tracked as a Milestone 2 calibration item.

**Session-granularity findings:**
- No `parent_session_id` / `agent_id` / `agent_type` in any payload, and `SubagentStart/Stop`
  did not fire. Hooks give **session-level** granularity (one light per `session_id`) — which
  is what the bar wants; subagents don't spawn their own lights.
- A single window can spawn **many short-lived sessions**, each with a full
  `SessionStart → UserPromptSubmit → Stop → SessionEnd` lifecycle (observed: ApplicationBot
  ran ~12). The bar must add/remove lights on `SessionStart`/`SessionEnd` and still rely on
  the heartbeat (decision 004) for unclean deaths.

**Window scoping (feature research):**
- `~/.claude/ide/<port>.lock` = one file per open VS Code window, each listing
  `workspaceFolders`. A session's `cwd` matches its window's workspace folder → **the
  workspace folder is the window key**, derivable from the `cwd` we already store.
- `VSCODE_PID` / `VSCODE_IPC_HOOK` are the **shared** main VS Code process (identical across
  windows) — not usable as a per-window key. No per-window port is exposed in the session
  env. Limitation: two windows on the *same* folder collapse into one group.
- The floating bar has no innate "current window," so automatic "this window only" is the
  **extension's** job (it knows its own workspace); the bar does "all windows" for free.

**Decision:** Adopt the verified mapping above as the signal contract for Milestone 2, with
the error signal marked interim pending a real `StopFailure` observation. Scope windows by
workspace folder (from `cwd`, cross-checked against the IDE lock files); deliver automatic
"this window" via the extension (decision 005), all-windows in the bar by default.

## 007 — Status store: one file per session (not a single shared JSON)

**Date:** 2026-07-05
**Status:** Accepted (refines #002)

**Context:** Decision 002 chose "a shared JSON status file" as the transport. Implementing
the Milestone 2 hook surfaced a concurrency problem #002 glossed over: Milestone 1 showed
**many sessions fire hooks concurrently** (ApplicationBot alone ran ~12). A single shared
`sessions.json` forces every hook into a read-modify-write on the same file → lost updates
and torn reads. Safe concurrent writes would need a mutex, and macOS ships no `flock`.

**Options considered:**
| Option | Pros | Cons |
|---|---|---|
| Single shared `sessions.json` | One file to read; one watch target | Concurrent read-modify-write races; needs a lock; no `flock` on macOS; awkward from a fail-silent shell hook |
| **One file per session** `sessions/<id>.json` | Each hook writes only its own file → zero cross-session contention; `SessionEnd` = delete the file; stale cleanup = delete old files; atomic per-file write via temp+rename | App reads N small files instead of 1 (trivial); no single-read snapshot (fine for a status light) |

**Decision:** Store one JSON file per session at `~/.claude/status/sessions/<session_id>.json`
(overridable via `$CLAUDESTATUS_DIR`). Each hook writes only its own session's file
(temp-file + atomic rename); `SessionEnd` deletes it. The display app watches the `sessions/`
directory. Same object shape as #002 (`state`, `cwd`, `label`, `updated_at`).

**Reasoning:** The per-session layout removes the multi-writer race by construction — the
one hard problem with a shared file — while keeping every property #002 wanted (files the
app watches, persistence across restarts) and making removal and stale-cleanup trivial. The
only cost is reading a directory instead of one file, which is immaterial. This keeps the
hook a fast, lock-free, fail-silent write, satisfying Agent Guideline #3.

**Validation:** `report.sh` unit-tested across all branches (running/blocked/idle/error,
interrupt-skip, `SessionEnd` removal, missing-`session_id` safety), replayed against the 160
real M1 events (ended sessions correctly removed, live ones retained with correct state), and
installed live — confirmed real-time population of `~/.claude/status/sessions/` from running
sessions. Error signal still interim: `report.sh` mirrors `PostToolUseFailure`/`StopFailure`
to `~/.claude/status/calibration.log` (event/session/tool only, no `tool_input`) to confirm
the real red trigger from live data.

## 008 — macOS overlay: non-activating NSPanel + Accessory app

**Date:** 2026-07-05
**Status:** Accepted
**Stack note:** Rust toolchain installed via rustup (1.96, minimal profile); app scaffolded
with `create-tauri-app` (Tauri v2, vanilla template, static frontend served from `../src`,
`withGlobalTauri`). Transparency requires `app.macOSPrivateApi: true`.

**Context:** The bar must be a small, borderless, transparent, always-on-top, drag-to-position
window that stays visible over **everything** — including when the user switches to another
app's **full-screen** space (the primary use case: coding in full-screen VS Code). Getting
that behavior on macOS took several escalating attempts, each ruled out by live testing:

| Attempt | Result |
|---|---|
| tao `set_always_on_top(true)` (config `alwaysOnTop`) — floating window level | Gets covered when another window is focused |
| Native `NSWindow.setLevel(25)` + `collectionBehavior(CanJoinAllSpaces \| FullScreenAuxiliary \| Stationary)` via objc2 | Stays on top **within** a Space, but not over another app's full-screen space |
| + `ActivationPolicy::Accessory` (no Dock icon, not space-managed) | Still not over full-screen |
| **Non-activating NSPanel** (`tauri-nspanel`) + Accessory | **Works** — floats over third-party full-screen without stealing focus or switching Spaces |

**Decision:** Convert the main window into a **non-activating NSPanel** using the
`tauri-nspanel` crate (git, `v2` branch) and run the app as an **Accessory** app. Panel
config (from the crate's `fullscreen` example): level `4` (NSFloatingWindowLevel), style mask
`NSWindowStyleMaskNonActivatingPanel` (`1<<7`), collection behavior
`FullScreenAuxiliary | CanJoinAllSpaces`. Also: window auto-sizes to its content (measured
**after** paint via double-rAF, clamped to a minimum, so it never shrinks to 0 and blocks
clicks behind it — a bug that made it invisible at first); position is remembered via
`tauri-plugin-window-state`.

**Reasoning:** macOS only lets a **non-activating panel** sit over another application's
full-screen window; a normal window (any level / collection behavior) cannot. The Accessory
policy removes the Dock icon (correct for a status-bar utility) and stops the window from
being space-managed. `tauri-nspanel` does the NSWindow→NSPanel conversion cleanly and
resolved against our Tauri 2.11 with no version conflict, so it beat hand-rolling the class
swap in objc2. Superseded the objc2 `NSWindow` approach that only worked within a Space.

## 009 — Hover detail (task + activity) and subagent count badge

**Date:** 2026-07-05
**Status:** Accepted

**Context:** Two Milestone-4 features: (a) hovering a light should show what the agent is
working on; (b) surface subagents. Both hinge on what the hooks expose.

**What the hooks give us (verified live):**
- `UserPromptSubmit.prompt` = the turn's task; `PreToolUse.tool_name`/`tool_input` = current
  activity; `Stop.last_assistant_message` = the wrap-up. `report.sh` distills these into two
  fields per session — `task` (carried across the turn via a read-merge of the prior file)
  and `detail` (current activity) — storing only short truncated summaries, never full
  `tool_input`.
- **Subagents:** `SubagentStart`/`SubagentStop` fire and carry `agent_id` + `agent_type`
  under the **parent's** `session_id`. Crucially, a subagent's own tool calls fire
  `PreToolUse`/`PostToolUse` with the parent `session_id` and **no `agent_id`** — so an
  individual tool call cannot be attributed to a specific subagent.

**Decision:**
- Tooltip = native OS `title` (multi-line): `name — state`, `↳ task`, subagent summary,
  `detail`. Native tooltip chosen because the window is sized to hug the pill, so a custom
  in-window tooltip would be clipped; the OS tooltip renders outside the window bounds.
- Subagents tracked as a `{agent_id: agent_type}` map in the session file — added on
  `SubagentStart`, removed on `SubagentStop`, cleared when the turn goes idle. Shown as a
  **count badge** on the light (chosen over mini sub-dots / hover-only); hover lists the
  types grouped with counts.
- Because subagent tool calls aren't attributable, we track **lifecycle only** (which types
  are running, how many, and each one's final message) — **not** each subagent's live tool.

**Frontend note:** dots are reconciled in place (keyed by id), not rebuilt each poll, so
updating a title/badge never dismisses an open hover tooltip. Window resize adds a small pad
so the corner badge isn't clipped.

**Validation:** `report.sh` unit-tested (task capture + carry-forward; subagent add/remove/
clear). Live: a concurrent poller confirmed a real subagent appeared in the parent's status
file for its full run and cleared on completion.

## 010 — Subagent storage: one marker file per subagent

**Date:** 2026-07-05
**Status:** Accepted (refines #009, applies #007 one level deeper)

**Context:** #009 first stored subagents as a `{agent_id: agent_type}` map inside the
session JSON, updated by a read-modify-write in the hook. Live testing with **two parallel
subagents** exposed a race: they share the parent's `session_id`, so their `SubagentStart`
hooks (and the flood of `PreToolUse` events from their tool calls, which also rewrite the
session file) do concurrent read-modify-writes on the *same* file and clobber each other —
only 1 of 2 subagents registered. Per-session files (#007) removed cross-session contention
but not *within*-session contention.

**Decision:** Store each subagent as its own marker file:
`sessions/<session_id>.subagents/<agent_id>` with the `agent_type` as contents. `SubagentStart`
creates the file, `SubagentStop` removes it, `Stop`/`SessionStart`/`SessionEnd` clear the dir.
The session JSON no longer carries subagents; the app reads the marker dir. Subagent events
are handled in a dedicated early branch of the hook — they never touch the session JSON.

**Reasoning:** One file per subagent means concurrent starts/stops operate on **different**
files, so there is no shared mutable state to race — the same insight as #007, one level
down. Verified: 8 concurrent `SubagentStart` for one session produced 8 markers (0 lost);
3 concurrent `SubagentStop` left exactly the right 5.

## 011 — Packaging: self-installing app (delivers decision 005)

**Date:** 2026-07-05
**Status:** Accepted

**Context:** Decision 005 chose a self-installing app so install is one action and covers
every project/window. Milestone 5 delivers it: a real `ClaudeStatus.app` (built with
`tauri build`) that wires up its own hooks with no node/repo dependency.

**Decision & mechanism:**
- The hook script is **embedded** into the binary at compile time
  (`include_str!("../../../hooks/report.sh")`) so the `.app` is self-contained and the
  installed hook always matches the shipped version.
- On launch (`app/src-tauri/src/install.rs::ensure_installed`, **release builds only** —
  `#[cfg(not(debug_assertions))]`), the app writes the script to a stable, app-independent
  path `~/.claude/status/report.sh`, creates `sessions/`, and merges the 11 hook entries into
  `~/.claude/settings.json` — idempotent (dedup by the `report.sh` marker), reversible
  (one-time `settings.json.claudestatus-bak`), non-clobbering (leaves other settings/hooks).
  This is the `setup.mjs` logic ported to Rust (serde_json).
- **Dev vs release split:** dev builds do **not** self-install, so `hooks/report.sh` edits
  stay live without a rebuild (dev registers the repo path via `node hooks/setup.mjs`); the
  release app owns the `~/.claude/status/report.sh` copy.
- Ships `.app` + `.dmg`; `install.sh` builds from source and copies to `/Applications`.
  Accessory app (no Dock icon); **launch-at-login is a documented manual step** (Login Items)
  — a `tauri-plugin-autostart` toggle is a future enhancement, not in v1.

**Trade-off — code signing:** the app is unsigned (ad-hoc). Locally-built copies run without
friction (no quarantine attribute), but a **downloaded/redistributed** copy hits Gatekeeper
and needs a one-time right-click → Open. Acceptable for personal use; real signing/notarizing
is out of scope for v1.

**Validation:** built the bundle; installed to `/Applications`; launched it; confirmed it
rewrote the hook path from the repo to `~/.claude/status/report.sh`, registered all 11 events
with exactly one entry each (dedup worked), wrote the executable script, backed up settings,
and preserved `permissions`/`theme`.

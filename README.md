# AgentStatus

A small, always-on-top **bar of lights** that shows the live status of every open
Claude Code, Codex, Cursor, or Antigravity session — so you can tell at a glance which
of your concurrent agents is working, waiting on you, idle, or errored, without hunting
through windows.

Run several agent sessions across projects and windows and it's easy to lose track of
which one just finished, which is blocked on a permission prompt, and which hit an
error. AgentStatus floats one colored light per session over everything on screen
(including full-screen apps), updates in real time, and lets you click a light to jump
straight to that session.

Works with **Claude Code in VS Code**, **Codex**, **Cursor's native agent**, and
**Google's Antigravity IDE** (all drive the same hook). There's also an optional VS Code
extension that adds a per-window status-bar item for Claude Code in VS Code.

## Install (macOS, Apple Silicon)

The fastest path is the prebuilt DMG — no build tools, and the app wires up all its hooks
itself on first launch.

**Requirements:** macOS on Apple Silicon (M1 or later), and any of Claude Code, Codex,
Cursor, or Antigravity.

1. Download **`AgentStatus_0.4.0_aarch64.dmg`** from the
   [latest release](https://github.com/Gameslayer999/AgentStatus/releases/latest).
2. Open the DMG and drag **AgentStatus** into **Applications**.
3. The app is **unsigned**, so macOS Gatekeeper blocks it on first launch. Clear the
   download quarantine and open it:

   ```bash
   xattr -dr com.apple.quarantine /Applications/AgentStatus.app
   open /Applications/AgentStatus.app
   ```

   (Alternatively: double-click it, let macOS block it, then go to **System Settings →
   Privacy & Security**, scroll to the "AgentStatus was blocked" message, and click
   **Open Anyway**. On macOS 15+ the old right-click → Open shortcut no longer bypasses
   this for downloaded apps.)

On first launch the app **installs its own hooks** — it writes
`~/.claude/status/report.sh` and registers it across every host it finds: Claude Code
(`~/.claude/settings.json`), Codex (`~/.codex/hooks.json`), Cursor (`~/.cursor/hooks.json`),
and Antigravity (`~/.gemini/config/hooks.json`), backing up the originals first.
**Already-open Claude Code and Codex sessions pick it up immediately — no restart
needed**, though Codex may ask you to review/trust the new hook with `/hooks`.

AgentStatus is an accessory app (**no Dock icon**). To start it at login, add it in
**System Settings → General → Login Items**.

**Optional — faster click-to-focus:** grant AgentStatus **Accessibility** permission
(System Settings → Privacy & Security → Accessibility). This lets a light click raise a
same-Space window in ~0.2s instead of ~1s. Without it, click-to-focus still works via the
slower IDE CLI.

### Build from source instead

If you're on Intel, or want to build it yourself:

```bash
./install.sh
```

This needs [Rust](https://rustup.rs), Node, and `jq` (`brew install jq`). It builds the
app and copies it to `/Applications`; the app self-installs its hooks on first launch,
same as the DMG. (On a fresh install you still need the Gatekeeper step above.)

## The lights

Each light is one Claude Code, Codex, Cursor, or Antigravity session:

| Light | Meaning |
|---|---|
| 🟢 green | running — actively working on a turn |
| 🟠 orange (pulsing) | blocked — waiting for you (a permission prompt or a question) |
| ⚪ white | done — the turn just finished and you haven't looked yet |
| ⚫ dim gray | idle — finished and acknowledged (you've focused it) |
| 🔴 red (pulsing) | error — a turn failed |

- **Hover** a light to see the session's project, its task, and what it's doing right now.
- **A blue count badge** on a light means that session has that many subagents running
  (hover lists their types).
- **Click** a light to jump to that session's window (VS Code, Cursor, or Antigravity) and
  reveal its tab.
- **Right-click** the bar to open settings — orientation (row/column), light size, spacing,
  per-state colors, and bar opacity.
- **Drag** the bar (grab the padding, not a light) to position it anywhere; it remembers
  where you put it and floats over everything, including full-screen apps.

## How it works

Two pieces, decided independently (see [DECISIONS.md](DECISIONS.md) for the why):

- **Signal layer** — a single **hook** (`report.sh`) fires on session lifecycle events and
  writes each session's state to `~/.claude/status/sessions/<id>.json`. Hooks are global, so
  **one install covers every project and Claude Code / Codex / Cursor / Antigravity window**.
  The hook does the minimum work and exits — it never blocks or slows down a turn.
- **Display layer** — a **Tauri** app (a non-activating macOS `NSPanel`) watches that
  directory and renders the lights.

The status file holds only what the lights need — `session_id`, coarse state, a short
project label, and a timestamp. No prompt or transcript content is stored. (The one
transcript read is on Antigravity, whose hook payload carries no prompt text: the hook
extracts just the short task label from the thread transcript — nothing else is read or
kept.)

## Optional — VS Code extension

The extension adds a per-window status-bar item (scoped to that window's workspace) with
the same hover detail and click-to-focus. It reads the same status files, so it needs the
app (or the dev hooks) installed for the signal.

```bash
code --install-extension extension/claudestatus-0.1.2.vsix
```

## Uninstall

```bash
node hooks/setup.mjs uninstall     # remove the hooks from settings.json
rm -rf /Applications/AgentStatus.app ~/.claude/status
```

Your original settings are backed up at `~/.claude/settings.json.agentstatus-bak`.

## Develop

```bash
cd app
npm install
node ../hooks/setup.mjs install   # register Claude + Codex repo hooks (dev points at hooks/report.sh)
npm run tauri dev
```

In dev the app does **not** self-install (so edits to `hooks/report.sh` are live without a
rebuild); the release build does. `node hooks/setup.mjs status|uninstall` manages the dev
hooks.

## Notes & limits

- **macOS only** (uses a non-activating `NSPanel` + private transparency API to float
  over full-screen apps). Prebuilt DMG is **Apple Silicon only**; Intel builds from source.
- **The app is unsigned/unnotarized** — hence the Gatekeeper step. Nothing is code-signed
  yet.
- A light == one `session_id`, labeled by its project folder. Two windows on the *same*
  folder collapse into one label.
- On **Cursor**, blocked (orange) is unavailable — Cursor doesn't emit a permission event.
- On **Codex**, newly installed hooks may need review/trust in `/hooks` before they run.
- **Antigravity** support is newer and less battle-tested: its lights show only running
  (green) and idle/done, never orange/red — Antigravity registers no permission-request or
  turn-failure event.
- Sessions with no activity for 2h are pruned (they reappear on their next event).
- Subagents are tracked by lifecycle (which are running + their types), not by their
  individual live tool calls — those aren't attributable to a specific subagent.

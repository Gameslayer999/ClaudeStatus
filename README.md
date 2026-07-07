# ClaudeStatus

A small, always-on-top **bar of lights** that shows the live status of every open
Claude Code session — so you can tell at a glance which of your concurrent sessions
is working, waiting on you, idle, or errored, without hunting through VS Code windows.

Run several Claude Code sessions across projects and windows and it's easy to lose track
of which one just finished, which is blocked on a permission prompt, and which hit an
error. ClaudeStatus floats one colored light per session over everything on screen
(including full-screen apps), updates in real time, and lets you click a light to jump
straight to that session.

Each light is one Claude Code session:

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
- **Click** a light to jump to that session's VS Code (or Cursor) window and reveal its tab.
- **Right-click** the bar to open settings — orientation (row/column), light size, spacing,
  per-state colors, and bar opacity.
- **Drag** the bar (grab the padding, not a light) to position it anywhere; it remembers
  where you put it and floats over everything, including full-screen apps.

Works with **Claude Code in VS Code** and **Cursor's native agent** (both drive the same
hook). There's also an optional VS Code extension that adds a per-window status-bar item.

## How it works

Two pieces, decided independently (see [DECISIONS.md](DECISIONS.md) for the why):

- **Signal layer** — a Claude Code **hook** (`report.sh`) fires on session lifecycle
  events and writes each session's state to `~/.claude/status/sessions/<id>.json`.
  Hooks are global, so **one install covers every project and VS Code/Cursor window**.
  The hook does the minimum work and exits — it never blocks or slows down a turn.
- **Display layer** — a **Tauri** app (a non-activating macOS `NSPanel`) watches that
  directory and renders the lights.

The status file holds only what the lights need — `session_id`, coarse state, a short
project label, and a timestamp. No prompt or transcript content is read or stored.

## Install (macOS, Apple Silicon)

**Requirements:** macOS on Apple Silicon (M1 or later), and Claude Code and/or Cursor.

1. Download **`ClaudeStatus_0.2.0_aarch64.dmg`** from the
   [latest release](https://github.com/Gameslayer999/ClaudeStatus/releases/latest).
2. Open the DMG and drag **ClaudeStatus** into **Applications**.
3. The app is **unsigned**, so macOS Gatekeeper blocks it on first launch. Clear the
   download quarantine and open it:

   ```bash
   xattr -dr com.apple.quarantine /Applications/ClaudeStatus.app
   open /Applications/ClaudeStatus.app
   ```

   (Alternatively: double-click it, let macOS block it, then go to **System Settings →
   Privacy & Security**, scroll to the "ClaudeStatus was blocked" message, and click
   **Open Anyway**. On macOS 15+ the old right-click → Open shortcut no longer bypasses
   this for downloaded apps.)

On first launch the app **installs its own hooks** — it writes
`~/.claude/status/report.sh`, registers it in `~/.claude/settings.json` (backing up the
original first), and adds the matching Cursor hooks. **Already-open Claude Code sessions
pick it up immediately — no restart needed.**

ClaudeStatus is an accessory app (**no Dock icon**). To start it at login, add it in
**System Settings → General → Login Items**.

**Optional — faster click-to-focus:** grant ClaudeStatus **Accessibility** permission
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
rm -rf /Applications/ClaudeStatus.app ~/.claude/status
```

Your original settings are backed up at `~/.claude/settings.json.claudestatus-bak`.

## Develop

```bash
cd app
npm install
node ../hooks/setup.mjs install   # register the repo's hooks (dev points at hooks/report.sh)
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
- Sessions with no activity for 2h are pruned (they reappear on their next event).
- Subagents are tracked by lifecycle (which are running + their types), not by their
  individual live tool calls — those aren't attributable to a specific subagent.

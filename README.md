# ClaudeStatus

A small, always-on-top **bar of lights** that shows the live status of every open
Claude Code session — so you can tell at a glance which of your concurrent sessions
is working, waiting on you, idle, or errored, without hunting through VS Code windows.

Each light is one Claude Code session:

| Light | Meaning |
|---|---|
| 🟢 green | running — actively working on a turn |
| 🟠 orange (pulsing) | blocked — waiting for you (a permission prompt or a question) |
| ⚪ gray | idle — turn finished, ready for the next prompt |
| 🔴 red (pulsing) | error — a turn or tool failed |

- **Hover** a light to see the session's project, its task, and what it's doing right now.
- **A blue count badge** on a light means that session has that many subagents running
  (hover lists their types).
- **Click** a light to jump to that session's VS Code window.
- **Drag** the bar (grab the padding, not a light) to position it anywhere; it remembers
  where you put it and floats over everything, including full-screen apps.

## How it works

Two pieces (see [DECISIONS.md](DECISIONS.md) for the why):

- **Signal layer** — a Claude Code **hook** (`report.sh`) fires on session lifecycle
  events and writes each session's state to `~/.claude/status/sessions/<id>.json`.
  Hooks are global, so **one install covers every project and VS Code window**.
- **Display layer** — a **Tauri** app (a non-activating macOS `NSPanel`) watches that
  directory and renders the lights.

## Install

Requires macOS, [Rust](https://rustup.rs), Node, and `jq` (`brew install jq`).

```bash
./install.sh
```

This builds the app and copies it to `/Applications`. Then launch it once — it
**installs its own hooks** on first launch (writing `~/.claude/status/report.sh` and
registering it in `~/.claude/settings.json`, with a backup):

```bash
open /Applications/ClaudeStatus.app
```

First launch only: the app is unsigned, so right-click it in Finder → **Open** to get
past Gatekeeper. It's an accessory app (no Dock icon). To start it at login, add it in
**System Settings → General → Login Items**.

Already-open Claude Code sessions pick up the hooks immediately — no restart needed.

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

## Uninstall

```bash
node hooks/setup.mjs uninstall     # remove the hooks from settings.json
rm -rf /Applications/ClaudeStatus.app ~/.claude/status
```

Your original settings are backed up at `~/.claude/settings.json.claudestatus-bak`.

## Notes & limits

- **macOS only** (uses a non-activating `NSPanel` + private transparency API to float
  over full-screen apps).
- A light == one `session_id`, labeled by its project folder. Two windows on the *same*
  folder collapse into one label.
- Sessions with no activity for 2h are pruned (they reappear on their next event).
- Subagents are tracked by lifecycle (which are running + their types), not by their
  individual live tool calls — those aren't attributable to a specific subagent.

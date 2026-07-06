#!/usr/bin/env bash
# ClaudeStatus installer — builds the app from source and installs it to
# /Applications. The app wires up its own Claude Code hooks on first launch,
# so this script only needs to build and place it.
set -euo pipefail
cd "$(dirname "$0")"

echo "== ClaudeStatus installer =="

# --- prerequisites ---
command -v jq   >/dev/null 2>&1 || { echo "Missing: jq (install with: brew install jq)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Missing: node (https://nodejs.org)"; exit 1; }
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null 2>&1 || { echo "Missing: Rust toolchain (install from https://rustup.rs)"; exit 1; }

# --- build ---
echo "Building the app (the first build downloads crates and can take a few minutes)…"
cd app
npm install
npm run tauri build

APP="src-tauri/target/release/bundle/macos/ClaudeStatus.app"
[ -d "$APP" ] || { echo "Build did not produce $APP"; exit 1; }

# --- install ---
PROC="ClaudeStatus.app/Contents/MacOS/app"
WAS_RUNNING=0
pgrep -f "$PROC" >/dev/null 2>&1 && WAS_RUNNING=1

echo "Installing to /Applications/ClaudeStatus.app…"
rm -rf "/Applications/ClaudeStatus.app"
cp -R "$APP" "/Applications/ClaudeStatus.app"

# If an instance was already running, it's been Gatekeeper-approved before — quit
# and relaunch it so the rebuild takes effect. (The single-instance guard would
# otherwise make the new launch exit against the still-running old build, leaving
# the old code on screen.) First-time installs fall through to manual instructions
# because an unsigned app can't be `open`ed past Gatekeeper without a right-click.
if [ "$WAS_RUNNING" = "1" ]; then
  echo "Restarting the running ClaudeStatus…"
  pkill -f "$PROC" || true
  # Wait for the process to exit and release its single-instance socket.
  for _ in $(seq 1 20); do pgrep -f "$PROC" >/dev/null 2>&1 || break; sleep 0.2; done
  sleep 0.3
  open "/Applications/ClaudeStatus.app"
  echo "Done. ClaudeStatus rebuilt and relaunched."
  exit 0
fi

cat <<'EOF'

Done. Launch it once to wire up the hooks and show the bar:

  open /Applications/ClaudeStatus.app

First launch only: because the app is unsigned, macOS Gatekeeper will block it —
right-click the app in Finder and choose "Open", then confirm.

The app is an accessory app (no Dock icon). To have it start automatically:
  System Settings → General → Login Items → add ClaudeStatus.

Optional — faster window switching: grant ClaudeStatus Accessibility permission
(System Settings → Privacy & Security → Accessibility → add ClaudeStatus). This
lets a light click raise a same-Space window in ~0.2s instead of ~1s. Without it,
click-to-focus still works, just via the slower IDE CLI.

To uninstall: delete /Applications/ClaudeStatus.app and run
  node hooks/setup.mjs uninstall
(or restore ~/.claude/settings.json.claudestatus-bak).
EOF

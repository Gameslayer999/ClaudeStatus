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
echo "Installing to /Applications/ClaudeStatus.app…"
rm -rf "/Applications/ClaudeStatus.app"
cp -R "$APP" "/Applications/ClaudeStatus.app"

cat <<'EOF'

Done. Launch it once to wire up the hooks and show the bar:

  open /Applications/ClaudeStatus.app

First launch only: because the app is unsigned, macOS Gatekeeper will block it —
right-click the app in Finder and choose "Open", then confirm.

The app is an accessory app (no Dock icon). To have it start automatically:
  System Settings → General → Login Items → add ClaudeStatus.

To uninstall: delete /Applications/ClaudeStatus.app and run
  node hooks/setup.mjs uninstall
(or restore ~/.claude/settings.json.claudestatus-bak).
EOF

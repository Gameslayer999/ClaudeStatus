#!/usr/bin/env bash
# ClaudeStatus — Cursor signal-verification logger (temporary; Agent Guideline #4).
#
# Captures every Cursor hook event plus its full stdin payload so we can verify,
# against the installed Cursor version, which events actually fire and what
# identity/cwd fields they carry — BEFORE building the real Cursor signal hook.
# Mirrors hooks/log-events.sh (the Claude Code logger). This is a throwaway
# verification tool, not the real signal layer.
#
# MUST be fail-silent, non-blocking, and NON-GATING (Agent Guideline #3 — never
# slow or block the user's live Cursor agent):
#   - only ever writes to a log file, never to stdout,
#   - always exits 0 (never blocks an action; exit 2 would),
#   - is attached to observational events only (no before*-execution gates).
# The event name is passed as $1; the payload arrives as JSON on stdin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/../logs/cursor-events.log"
EVENT="${1:-unknown}"

{
  payload="$(cat)"
  ts="$(date +%Y-%m-%dT%H:%M:%S%z)"
  envs="$(env | grep -iE 'cursor|workspace|composer' | tr '\n' ';')"
  {
    printf '===== %s  arg=%s  pwd=%s =====\n' "$ts" "$EVENT" "$PWD"
    printf 'env: %s\n' "$envs"
    printf '%s\n' "$payload"
  } >>"$LOG_FILE"
} >/dev/null 2>&1

exit 0

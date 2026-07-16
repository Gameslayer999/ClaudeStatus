#!/usr/bin/env bash
# AgentStatus — Milestone 1 event logger.
#
# Captures every Claude Code hook event plus its full stdin payload so we can
# verify, against the installed version, which events actually fire and what
# fields they carry (Agent Guideline #4). This is a temporary verification tool,
# not the real signal layer.
#
# MUST be fail-silent and non-blocking (Agent Guideline #3):
#   - never write to stdout (a PreToolUse hook's stdout can alter permissions),
#   - never exit non-zero,
#   - never delay the session.
# The event name is passed as $1; the payload arrives as JSON on stdin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/../logs/events.log"
EVENT="${1:-unknown}"

{
  payload="$(cat)"
  ts="$(date +%Y-%m-%dT%H:%M:%S%z)"
  {
    printf '===== %s  arg=%s  entry=%s  child=%s =====\n' \
      "$ts" "$EVENT" "${CLAUDE_CODE_ENTRYPOINT:-?}" "${CLAUDE_CODE_CHILD_SESSION:-?}"
    printf '%s\n' "$payload"
  } >>"$LOG_FILE"
} >/dev/null 2>&1

exit 0

#!/usr/bin/env bash
# ClaudeStatus — the real signal hook.
#
# Maps one Claude Code hook event to a session state and records it in a
# per-session status file: $CLAUDESTATUS_DIR/sessions/<session_id>.json
# (default ~/.claude/status/sessions/). One file per session → concurrent
# sessions never contend (decision 007).
#
# Contract (verified on Claude Code 2.1.201 — DECISIONS.md #006):
#   running  <- UserPromptSubmit | PreToolUse | PostToolUse
#   blocked  <- PermissionRequest
#   idle     <- Stop | SessionStart
#   error    <- StopFailure | PostToolUseFailure (interim; skips user interrupts)
#   remove   <- SessionEnd
#
# MUST be fast, non-blocking, and fail-silent (Agent Guideline #3): never write
# to stdout, never exit non-zero, swallow every error. Invoked as:
#   report.sh <EventName>          (event JSON arrives on stdin)
#
# Dependency: jq (present on this machine; the Milestone 5 installer will verify it).

STATUS_DIR="${CLAUDESTATUS_DIR:-$HOME/.claude/status}"
SESSIONS_DIR="$STATUS_DIR/sessions"
EVENT="${1:-}"

{
  payload="$(cat)"

  # SessionEnd: drop this session's light and stop.
  if [ "$EVENT" = "SessionEnd" ]; then
    sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
    [ -n "$sid" ] && rm -f "$SESSIONS_DIR/$sid.json" 2>/dev/null
    exit 0
  fi

  ts="$(date +%s)"

  # Single jq pass: map event -> state, filter, and emit "<sid>\t<compact-json>".
  line="$(printf '%s' "$payload" | jq -rc --arg event "$EVENT" --argjson ts "$ts" '
    ({ "UserPromptSubmit":"running", "PreToolUse":"running", "PostToolUse":"running",
       "PermissionRequest":"blocked", "Stop":"idle", "SessionStart":"idle",
       "StopFailure":"error", "PostToolUseFailure":"error" }[$event]) as $state
    | select($state != null)
    | select((.session_id // "") != "")
    | select($event != "PostToolUseFailure" or (.is_interrupt // false) == false)
    | .session_id + "\t" + ({ state: $state,
        cwd: (.cwd // ""),
        label: ((.cwd // "") | split("/") | map(select(length > 0)) | last // ""),
        updated_at: $ts } | tojson)
  ' 2>/dev/null)"

  [ -z "$line" ] && exit 0
  sid="${line%%$'\t'*}"
  obj="${line#*$'\t'}"

  # Atomic write: temp file in the same dir, then rename.
  mkdir -p "$SESSIONS_DIR" 2>/dev/null
  tmp="$SESSIONS_DIR/.$sid.$$.tmp"
  printf '%s\n' "$obj" >"$tmp" 2>/dev/null && mv -f "$tmp" "$SESSIONS_DIR/$sid.json" 2>/dev/null
  rm -f "$tmp" 2>/dev/null

  # Error-signal calibration side-log (M1 open item): confirm the real red
  # trigger from live data. Records event/session/tool only — never tool_input.
  if [ "$EVENT" = "PostToolUseFailure" ] || [ "$EVENT" = "StopFailure" ]; then
    tool="$(printf '%s' "$payload" | jq -r '.tool_name // ""' 2>/dev/null)"
    intr="$(printf '%s' "$payload" | jq -r '.is_interrupt // false' 2>/dev/null)"
    printf '%s\t%s\t%s\ttool=%s\tinterrupt=%s\n' "$ts" "$EVENT" "$sid" "$tool" "$intr" \
      >>"$STATUS_DIR/calibration.log" 2>/dev/null
  fi
} >/dev/null 2>&1

exit 0

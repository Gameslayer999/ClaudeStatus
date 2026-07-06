#!/usr/bin/env bash
# ClaudeStatus — the real signal hook.
#
# Maps one Claude Code hook event to a session state (and a short "what it's
# working on" description) and records it in a per-session status file:
# $CLAUDESTATUS_DIR/sessions/<session_id>.json (default ~/.claude/status/sessions/).
# One file per session → concurrent sessions never contend (decision 007).
#
# Subagents get one marker file each, under sessions/<session_id>.subagents/<agent_id>
# (contents = agent_type). Parallel subagents therefore never race on a shared file
# — decision 007 applied one level deeper (decision 010).
#
# Contract (verified on Claude Code 2.1.201 — DECISIONS.md #006):
#   running  <- UserPromptSubmit | PreToolUse | PostToolUse
#   blocked  <- PermissionRequest
#   idle     <- Stop | SessionStart
#   error    <- StopFailure | PostToolUseFailure (interim; skips user interrupts)
#   remove   <- SessionEnd
#   subagent <- SubagentStart (add marker) | SubagentStop (remove marker)
#
# Session file fields: state, cwd, label, updated_at, task, detail.
#   task   = the current turn's user prompt (carried across events).
#   detail = current activity (tool being run / waiting / last message).
# Only short, truncated summaries are stored — never full tool_input.
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
  sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
  [ -z "$sid" ] && exit 0
  subdir="$SESSIONS_DIR/$sid.subagents"

  # SessionEnd: drop this session's light and its subagent markers.
  if [ "$EVENT" = "SessionEnd" ]; then
    rm -f "$SESSIONS_DIR/$sid.json" 2>/dev/null
    rm -rf "$subdir" 2>/dev/null
    exit 0
  fi

  # Subagents: one marker file per subagent — race-free under parallel subagents.
  if [ "$EVENT" = "SubagentStart" ] || [ "$EVENT" = "SubagentStop" ]; then
    aid="$(printf '%s' "$payload" | jq -r '.agent_id // empty' 2>/dev/null)"
    [ -z "$aid" ] && exit 0
    if [ "$EVENT" = "SubagentStart" ]; then
      atype="$(printf '%s' "$payload" | jq -r '.agent_type // "agent"' 2>/dev/null)"
      mkdir -p "$subdir" 2>/dev/null
      printf '%s' "$atype" >"$subdir/$aid" 2>/dev/null
    else
      rm -f "$subdir/$aid" 2>/dev/null
    fi
    exit 0
  fi

  ts="$(date +%s)"
  old_json=""
  [ -f "$SESSIONS_DIR/$sid.json" ] && old_json="$(cat "$SESSIONS_DIR/$sid.json" 2>/dev/null)"

  # One jq pass: map event -> state, carry forward task, compute a fresh detail,
  # and emit the merged status object (or empty to skip unmapped events).
  obj="$(printf '%s' "$payload" | jq -c \
      --arg event "$EVENT" --argjson ts "$ts" --arg oldjson "$old_json" '
    def clean: (. // "") | gsub("[\n\r\t]+";" ") | gsub("^ +| +$";"");
    def trunc($n): clean | if (length > $n) then (.[:$n] + "…") else . end;
    ($oldjson | if . == "" then {} else (fromjson? // {}) end) as $old
    | . as $p
    | ({ "UserPromptSubmit":"running", "PreToolUse":"running", "PostToolUse":"running",
         "PermissionRequest":"blocked", "Stop":"idle", "SessionStart":"idle",
         "StopFailure":"error", "PostToolUseFailure":"error" }[$event]) as $state
    | select($state != null)
    | select($event != "PostToolUseFailure" or ($p.is_interrupt // false) == false)
    | (($p.cwd // $old.cwd) // "") as $cwd
    | ($p.tool_name // "") as $tool
    | (if $event == "UserPromptSubmit" then ($p.prompt | trunc(160)) else ($old.task // "") end) as $task
    | (if $event == "PreToolUse" then
         (if $tool == "Bash" then "$ " + ($p.tool_input.command | trunc(90))
          elif ($tool | test("^(Edit|Write|Read|NotebookEdit)$")) then
            $tool + " " + (($p.tool_input.file_path // "") | split("/") | last)
          else "Running " + $tool end)
       elif $event == "PermissionRequest" then
         (if $tool == "AskUserQuestion" then "⏸ waiting — a question for you"
          else "⏸ waiting — approve " + $tool end)
       elif $event == "Stop" then (($p.last_assistant_message // "") | trunc(160))
       elif ($event == "StopFailure" or $event == "PostToolUseFailure") then
         ("⚠ error" + (if $tool != "" then " — " + $tool else "" end))
       elif $event == "SessionStart" then ""
       else ($old.detail // "") end) as $detail
    | { state: $state, cwd: $cwd,
        label: ($cwd | split("/") | map(select(length > 0)) | last // ""),
        updated_at: $ts, task: $task, detail: $detail }
  ' 2>/dev/null)"

  [ -z "$obj" ] && exit 0

  # Atomic write: temp file in the same dir, then rename.
  mkdir -p "$SESSIONS_DIR" 2>/dev/null
  tmp="$SESSIONS_DIR/.$sid.$$.tmp"
  printf '%s\n' "$obj" >"$tmp" 2>/dev/null && mv -f "$tmp" "$SESSIONS_DIR/$sid.json" 2>/dev/null
  rm -f "$tmp" 2>/dev/null

  # Turn boundary: clear any lingering subagent markers (a subagent that died
  # without SubagentStop). By a clean Stop, all real subagents have already ended.
  if [ "$EVENT" = "Stop" ] || [ "$EVENT" = "SessionStart" ]; then
    rm -rf "$subdir" 2>/dev/null
  fi

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

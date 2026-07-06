#!/usr/bin/env bash
# ClaudeStatus — the real signal hook.
#
# Maps one Claude Code hook event to a session state (and a short "what it's
# working on" description) and records it in a per-session status file:
# $CLAUDESTATUS_DIR/sessions/<session_id>.json (default ~/.claude/status/sessions/).
# One file per session → concurrent sessions never contend (decision 007).
#
# Subagents get one marker file each, under sessions/<session_id>.subagents/<agent_id>
# (contents = agent_type). Parallel subagents therefore never race (decision 010).
#
# Opt-out: if $CLAUDESTATUS_IGNORE is set, the session is not tracked at all — for
# programmatic/headless Claude calls (e.g. an app classifying text) that shouldn't
# appear as lights. Set it in the environment where you spawn Claude (decision 013).
#
# Contract (Claude Code 2.1.201 — DECISIONS.md #006; Cursor 3.10.11 — #018):
#   running  <- UserPromptSubmit | PreToolUse | PostToolUse
#   blocked  <- PermissionRequest  (Claude only; Cursor has no such event)
#   idle     <- Stop | SessionStart
#   error    <- StopFailure  (a real turn/API failure; PostToolUseFailure is a
#               recovered tool failure and does NOT flip the light — decision 013)
#            <- Stop with a failed .status  (Cursor turn-level error — #018, interim)
#   remove   <- SessionEnd
#   subagent <- SubagentStart (add marker) | SubagentStop (remove marker)
#
# Cursor support (decision 018): Cursor natively runs this hook via its Claude-compat
# bridge; a per-payload `ide` field ("cursor" when .cursor_version is present, else
# "vscode") drives click-to-focus. Cursor sends the workspace in .workspace_roots[]
# (not .cwd) and uses camelCase event names (normalized below).
#
# MUST be fast, non-blocking, and fail-silent (Agent Guideline #3): never write
# to stdout, never exit non-zero, swallow every error. Invoked as:
#   report.sh <EventName>          (event JSON arrives on stdin)
#
# Dependency: jq (present on this machine; the Milestone 5 installer will verify it).

STATUS_DIR="${CLAUDESTATUS_DIR:-$HOME/.claude/status}"
SESSIONS_DIR="$STATUS_DIR/sessions"
EVENT="${1:-}"

# Normalize Cursor's camelCase event names to the Claude PascalCase names the
# rest of this script keys on (decision 018). Cursor runs this same hook two ways:
# via its Claude-compat bridge (reads ~/.claude/settings.json, passes PascalCase)
# and via native ~/.cursor/hooks.json entries (camelCase) for the events the bridge
# drops — subagents and tool failures. Both paths land on the same logic below.
case "$EVENT" in
  sessionStart) EVENT=SessionStart;;   sessionEnd) EVENT=SessionEnd;;
  stop) EVENT=Stop;;                   beforeSubmitPrompt) EVENT=UserPromptSubmit;;
  preToolUse) EVENT=PreToolUse;;       postToolUse) EVENT=PostToolUse;;
  postToolUseFailure) EVENT=PostToolUseFailure;;
  subagentStart) EVENT=SubagentStart;; subagentStop) EVENT=SubagentStop;;
esac

{
  payload="$(cat)"
  # Opt-out for programmatic/headless sessions (decision 013).
  [ -n "$CLAUDESTATUS_IGNORE" ] && exit 0
  sid="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)"
  [ -z "$sid" ] && exit 0
  # Cursor fires sessionStart for an unopened "draft" composer — skip that phantom.
  [ "$sid" = "empty-state-draft" ] && exit 0
  subdir="$SESSIONS_DIR/$sid.subagents"

  # SessionEnd: drop this session's light and its subagent markers.
  if [ "$EVENT" = "SessionEnd" ]; then
    rm -f "$SESSIONS_DIR/$sid.json" 2>/dev/null
    rm -rf "$subdir" 2>/dev/null
    exit 0
  fi

  # Subagents: one marker file per subagent — race-free under parallel subagents.
  if [ "$EVENT" = "SubagentStart" ] || [ "$EVENT" = "SubagentStop" ]; then
    aid="$(printf '%s' "$payload" | jq -r '.agent_id // .subagent_id // empty' 2>/dev/null)"
    [ -z "$aid" ] && exit 0
    if [ "$EVENT" = "SubagentStart" ]; then
      atype="$(printf '%s' "$payload" | jq -r '.agent_type // .subagent_type // "agent"' 2>/dev/null)"
      mkdir -p "$subdir" 2>/dev/null
      printf '%s' "$atype" >"$subdir/$aid" 2>/dev/null
    else
      rm -f "$subdir/$aid" 2>/dev/null
    fi
    exit 0
  fi

  ts="$(date +%s)"

  # Failure calibration: a turn-level StopFailure is a real error (red); a
  # PostToolUseFailure is a recovered tool failure — log it but don't flip state.
  if [ "$EVENT" = "PostToolUseFailure" ] || [ "$EVENT" = "StopFailure" ]; then
    tool="$(printf '%s' "$payload" | jq -r '.tool_name // ""' 2>/dev/null)"
    intr="$(printf '%s' "$payload" | jq -r '.is_interrupt // false' 2>/dev/null)"
    printf '%s\t%s\t%s\ttool=%s\tinterrupt=%s\n' "$ts" "$EVENT" "$sid" "$tool" "$intr" \
      >>"$STATUS_DIR/calibration.log" 2>/dev/null
    [ "$EVENT" = "PostToolUseFailure" ] && exit 0
  fi

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
         "StopFailure":"error" }[$event]) as $base
    | ($p.cursor_version != null) as $isCursor
    | (($p.status // "") | test("error|fail|abort|cancel"; "i")) as $failedStop
    | (if $event == "Stop" and $failedStop then "error" else $base end) as $state
    | select($state != null)
    # Cursor puts the workspace in workspace_roots[]; a tool-level .cwd (e.g. /tmp) is
    # the exec dir of that tool call, not the session folder — prefer workspace_roots.
    | (if $isCursor then (($p.workspace_roots // [])[0] // $old.cwd) else ($p.cwd // $old.cwd) end // "") as $cwd
    | (if $isCursor then "cursor" else ($old.ide // "vscode") end) as $ide
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
       elif $event == "Stop" then
         (if $failedStop then ("⚠ turn failed — " + ($p.status // "")) else (($p.last_assistant_message // "") | trunc(160)) end)
       elif $event == "StopFailure" then ("⚠ turn failed" + (if ($p.error_type // "") != "" then " — " + $p.error_type else "" end))
       elif $event == "SessionStart" then ""
       else ($old.detail // "") end) as $detail
    | { state: $state, cwd: $cwd, ide: $ide,
        label: ($cwd | split("/") | map(select(length > 0)) | last // ""),
        updated_at: $ts, task: $task, detail: $detail }
  ' 2>/dev/null)"

  [ -z "$obj" ] && exit 0

  # Atomic write: temp file in the same dir, then rename.
  mkdir -p "$SESSIONS_DIR" 2>/dev/null
  tmp="$SESSIONS_DIR/.$sid.$$.tmp"
  printf '%s\n' "$obj" >"$tmp" 2>/dev/null && mv -f "$tmp" "$SESSIONS_DIR/$sid.json" 2>/dev/null
  rm -f "$tmp" 2>/dev/null

  # Turn boundary: clear any lingering subagent markers.
  if [ "$EVENT" = "Stop" ] || [ "$EVENT" = "SessionStart" ]; then
    rm -rf "$subdir" 2>/dev/null
  fi
} >/dev/null 2>&1

exit 0

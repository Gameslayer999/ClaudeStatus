#!/usr/bin/env bash
# AgentStatus — the real signal hook.
#
# Maps one Claude Code/Codex hook event to a session state (and a short "what it's
# working on" description) and records it in a per-session status file:
# $AGENTSTATUS_DIR/sessions/<session_id>.json (default ~/.claude/status/sessions/).
# Legacy $CLAUDESTATUS_DIR is still honored so existing installs keep working.
# One file per session → concurrent sessions never contend (decision 007).
#
# Subagents get one marker file each, under sessions/<session_id>.subagents/<agent_id>
# (contents = agent_type). Parallel subagents therefore never race (decision 010).
#
# Opt-out: if $AGENTSTATUS_IGNORE is set, the session is not tracked at all — for
# programmatic/headless agent calls (e.g. an app classifying text) that shouldn't
# appear as lights. Legacy $CLAUDESTATUS_IGNORE is still honored.
#
# Contract (Claude Code 2.1.201 — DECISIONS.md #006; Cursor 3.10.11 — #018;
# Codex hooks — official manual fetched 2026-07-09):
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
# Codex support: the same hook shape is installed into ~/.codex/hooks.json, with an
# explicit "codex" second argument (decision 032) — Codex payloads are Claude-shaped
# (session_id + cwd), so the host can't be sniffed from the payload. Codex command
# hooks run with the session cwd as their working directory, so cwd falls back to
# $PWD, and the session id accepts Codex thread/conversation id fields.
#
# MUST be fast, non-blocking, and fail-silent (Agent Guideline #3): never write
# to stdout, never exit non-zero, swallow every error. Invoked as:
#   report.sh <EventName> [ide]    (event JSON arrives on stdin; ide is "codex"
#                                   when registered in ~/.codex/hooks.json)
#
# Dependency: jq (present on this machine; the Milestone 5 installer will verify it).

STATUS_DIR="${AGENTSTATUS_DIR:-${CLAUDESTATUS_DIR:-$HOME/.claude/status}}"
SESSIONS_DIR="$STATUS_DIR/sessions"
EVENT="${1:-}"
IDE_ARG="${2:-}"

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
  { [ -n "$AGENTSTATUS_IGNORE" ] || [ -n "$CLAUDESTATUS_IGNORE" ]; } && exit 0
  sid="$(printf '%s' "$payload" | jq -r '.session_id // .thread_id // .threadId // .conversation_id // .conversationId // .thread.id // .conversation.id // empty' 2>/dev/null)"
  [ -z "$sid" ] && exit 0
  # Cursor fires sessionStart for an unopened "draft" composer — skip that phantom.
  [ "$sid" = "empty-state-draft" ] && exit 0
  subdir="$SESSIONS_DIR/$sid.subagents"

  # Antigravity only: its prompt-submit payload carries no prompt text, so recover the
  # last user turn from the thread transcript. Gated on the declared host (decision 033) —
  # every other host sends the prompt in the payload, and an ungated read walked its
  # fallback chain into the real Claude transcript on every UserPromptSubmit: a 10MB
  # read + python3 spawn per turn whose result jq then discarded (it scans for
  # Antigravity's USER_INPUT records, which Claude transcripts never contain).
  prompt=""
  if [ "$IDE_ARG" = "antigravity" ] && { [ "$EVENT" = "PreInvocation" ] || [ "$EVENT" = "UserPromptSubmit" ]; } && [ -n "$sid" ]; then
    transcript_path="$(printf '%s' "$payload" | jq -r '.transcriptPath // .transcript_path // empty' 2>/dev/null | sed 's/\.jsonl$/_full.jsonl/')"
    if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
      transcript_path="$HOME/.gemini/antigravity/brain/$sid/.system_generated/logs/transcript_full.jsonl"
    fi
    if [ ! -f "$transcript_path" ]; then
      transcript_path="$(printf '%s' "$payload" | jq -r '.transcriptPath // .transcript_path // empty' 2>/dev/null)"
      if [ -z "$transcript_path" ]; then
        transcript_path="$HOME/.gemini/antigravity/brain/$sid/.system_generated/logs/transcript.jsonl"
      fi
    fi
    if [ -f "$transcript_path" ]; then
      prompt="$(python3 -c '
import sys, json
try:
    content = sys.stdin.read()
    last = ""
    for i, part in enumerate(content.split("\n{\"step_index\":")):
        if i > 0: part = "{\"step_index\":" + part
        try:
            obj = json.loads(part)
            if obj.get("type") == "USER_INPUT":
                last = obj.get("content", "")
        except: pass
    print(last)
except: pass
' < "$transcript_path" 2>/dev/null)"
    fi
  fi

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
      --arg event "$EVENT" --argjson ts "$ts" --arg oldjson "$old_json" --arg ideArg "$IDE_ARG" --arg prompt "$prompt" '
    def clean: (. // "") | gsub("[\n\r\t]+";" ") | gsub("^ +| +$";"");
    def trunc($n): clean | if (length > $n) then (.[:$n] + "…") else . end;
    def extract_request: if test("<USER_REQUEST>") then ((capture("<USER_REQUEST>(?<s>.*?)</USER_REQUEST>"; "m").s | clean) as $req | if $req != "" then $req else . end) else . end;
    ($oldjson | if . == "" then {} else (fromjson? // {}) end) as $old
    | . as $p
    | ({ "UserPromptSubmit":"running", "PreToolUse":"running", "PostToolUse":"running",
         "PreInvocation":"running", "PostInvocation":"running",
         "PermissionRequest":"blocked", "Stop":"idle", "SessionStart":"idle",
         "StopFailure":"error" }[$event]) as $base
    | ($p.cursor_version != null) as $isCursor
    # Codex is declared by the installer (arg 2), never sniffed: Codex payloads carry
    # Claude-shaped session_id + cwd, so no payload heuristic can distinguish them.
    | ($ideArg == "codex") as $isCodex
    | ($ideArg == "antigravity") as $isAntigravity
    | (($p.status // "") | test("error|fail|abort|cancel"; "i")) as $failedStop
    | (if $event == "Stop" and $failedStop then "error" else $base end) as $state
    | select($state != null)
    # Cursor puts the workspace in workspace_roots[]; a tool-level .cwd (e.g. /tmp) is
    # the exec dir of that tool call, not the session folder — prefer workspace_roots.
    | (if $isCursor then (($p.workspace_roots // [])[0] // $old.cwd)
       elif $isCodex then ($p.cwd // $old.cwd // env.PWD)
       elif $isAntigravity then (($p.workspacePaths // [])[0] // $old.cwd)
       else ($p.cwd // $old.cwd) end // "") as $cwd
    | (if $isCursor then "cursor" elif $isCodex then "codex" elif $isAntigravity then "antigravity" else ($old.ide // "vscode") end) as $ide
    | ($p.toolCall.name // $p.tool_name // $p.toolName // $p.tool // "") as $tool
    | (if ($event | test("^(UserPromptSubmit|PreInvocation)$")) then
         ((if ($p.prompt // $p.user_prompt // $p.input // $p.text // "") != "" then ($p.prompt // $p.user_prompt // $p.input // $p.text)
           elif $prompt != "" then $prompt
           else ($old.task // "") end) | extract_request | trunc(160))
       else ($old.task // "") end) as $task
    | (if $event == "PreToolUse" then
         (if ($tool | test("^(Bash|run_command)$")) then
            "$ " + (($p.tool_input.command // $p.toolCall.args.CommandLine) | trunc(90))
          elif ($tool | test("^(Edit|Write|Read|NotebookEdit|write_to_file|replace_file_content|multi_replace_file_content|view_file|read_file|write_file)$"; "i")) then
            $tool + " " + (($p.tool_input.file_path // $p.toolCall.args.TargetFile // $p.toolCall.args.AbsolutePath // "") | split("/") | last)
          else "Running " + $tool end)
       elif $event == "PermissionRequest" then
         (if $tool == "AskUserQuestion" then "⏸ waiting — a question for you"
          else "⏸ waiting — approve " + $tool end)
       elif $event == "Stop" then
         (if $failedStop then ("⚠ turn failed — " + ($p.status // "")) else (($p.last_assistant_message // $p.lastAssistantMessage // $p.message // "") | trunc(160)) end)
       elif $event == "StopFailure" then ("⚠ turn failed" + (if ($p.error_type // "") != "" then " — " + $p.error_type else "" end))
       elif ($event | test("^(SessionStart|PreInvocation|PostInvocation)$")) then ""
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

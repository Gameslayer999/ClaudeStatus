// ClaudeStatus VS Code extension.
//
// Shows the live status of THIS window's Claude Code sessions as status-bar items
// (one per session whose cwd is within this window's workspace). Reads the same
// per-session files the hook writes (~/.claude/status/sessions/). Clicking an item
// focuses that session's tab via the Claude Code deep link — which works here
// because we're already in the session's own window.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const POLL_MS = 1500;
const MAX_IDLE_SECS = 2 * 60 * 60;

interface Session {
  id: string;
  state: string;
  cwd: string;
  label: string;
  updated_at: number;
  task: string;
  detail: string;
  subagents: string[];
}

function statusDir(): string {
  const env = process.env.CLAUDESTATUS_DIR;
  return env && env.length ? env : path.join(os.homedir(), ".claude", "status");
}
function sessionsDir(): string {
  return path.join(statusDir(), "sessions");
}

// The floating bar drops a focus request here when a light is clicked (decision 018):
// { session_id, requested_at (epoch ms) }. Only the window whose workspace owns that
// session acts on it — focusing the exact tab via claude-vscode.editor.open, which
// the bar can't call itself. Returns null when there's no (valid) request.
function readFocusRequest(): { session_id: string; requested_at: number } | null {
  try {
    const obj = JSON.parse(
      fs.readFileSync(path.join(statusDir(), "focus-request.json"), "utf8")
    );
    if (typeof obj.session_id === "string" && typeof obj.requested_at === "number") {
      return { session_id: obj.session_id, requested_at: obj.requested_at };
    }
  } catch {
    /* no request file yet */
  }
  return null;
}

// Highest requested_at we've already acted on, so each bar click fires exactly once.
// Seeded at activate to the current request so a stale file isn't replayed on reload.
let lastFocusReq = -1;

function readSessions(): Session[] {
  const dir = sessionsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = Date.now() / 1000;
  const out: Session[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const updated = typeof obj.updated_at === "number" ? obj.updated_at : 0;
    if (now - updated > MAX_IDLE_SECS) continue;
    let subs: string[] = [];
    try {
      const sd = path.join(dir, `${id}.subagents`);
      subs = fs.readdirSync(sd).map((a) => {
        try {
          return fs.readFileSync(path.join(sd, a), "utf8").trim() || "agent";
        } catch {
          return "agent";
        }
      });
    } catch {
      /* no subagents */
    }
    out.push({
      id,
      state: obj.state ?? "idle",
      cwd: obj.cwd ?? "",
      label: obj.label ?? "",
      updated_at: updated,
      task: obj.task ?? "",
      detail: obj.detail ?? "",
      subagents: subs,
    });
  }
  return out;
}

function inThisWindow(cwd: string, folders: string[]): boolean {
  return folders.some((f) => {
    const base = f.endsWith("/") ? f : f + "/";
    return cwd === f || cwd.startsWith(base);
  });
}

// Keyed by *display* state (see displayState). "done" renders at full brightness
// (default foreground) to stand out; acknowledged "idle" is dimmed so it recedes —
// the same bright-vs-dim relationship the floating bar uses (decision 014).
const STATE_COLOR: Record<string, vscode.ThemeColor | undefined> = {
  running: new vscode.ThemeColor("charts.green"),
  blocked: new vscode.ThemeColor("charts.yellow"),
  error: new vscode.ThemeColor("charts.red"),
  done: undefined,
  idle: new vscode.ThemeColor("disabledForeground"),
};

// App-local reviewed-tracking (decision 014). A finished-but-unacknowledged turn
// shows as "done"; clicking the item (which also focuses the session) acknowledges
// it, keyed by the finish time (updated_at) so the next finished turn re-lights.
// Not persisted — resets on extension reload, which is acceptable for a glance cue.
const reviewedAt = new Map<string, number>(); // session id -> acknowledged updated_at

// A finished turn = idle with a wrap-up message. `Stop` writes a non-empty detail;
// `SessionStart` forces detail="" — so detail distinguishes "a turn ended, output to
// review" from a fresh idle session with nothing to look at.
function isFinishedTurn(s: Session): boolean {
  return s.state === "idle" && !!s.detail;
}

function displayState(s: Session): string {
  if (isFinishedTurn(s) && reviewedAt.get(s.id) !== s.updated_at) return "done";
  return s.state;
}

function tooltipFor(s: Session, ds: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const stateText = ds === "done" ? "finished — click to acknowledge" : ds;
  md.appendMarkdown(`**${s.label || s.id.slice(0, 8)}** — ${stateText}\n\n`);
  if (s.task) md.appendMarkdown(`↳ ${s.task}\n\n`);
  if (s.subagents.length) {
    const counts: Record<string, number> = {};
    for (const t of s.subagents) counts[t] = (counts[t] || 0) + 1;
    const parts = Object.entries(counts).map(([t, c]) => (c > 1 ? `${t} ×${c}` : t));
    md.appendMarkdown(
      `${s.subagents.length} subagent${s.subagents.length > 1 ? "s" : ""}: ${parts.join(", ")}\n\n`
    );
  }
  if (s.detail) md.appendMarkdown("`" + s.detail.replace(/`/g, "'") + "`");
  return md;
}

const items = new Map<string, vscode.StatusBarItem>();

function refresh(): void {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const sessions = readSessions()
    .filter((s) => inThisWindow(s.cwd, folders))
    .sort((a, b) => a.id.localeCompare(b.id));

  const seen = new Set<string>();
  let priority = 100;
  for (const s of sessions) {
    seen.add(s.id);
    let item = items.get(s.id);
    if (!item) {
      item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority--);
      items.set(s.id, item);
    }
    const ds = displayState(s);
    const n = s.subagents.length;
    item.text = `$(circle-filled) ${s.label || s.id.slice(0, 6)}${n ? ` ${n}×` : ""}`;
    item.color = STATE_COLOR[ds];
    item.tooltip = tooltipFor(s, ds);
    // Pass the current finish time so the click acknowledges exactly this turn.
    item.command = {
      title: "Focus session",
      command: "claudestatus.focusSession",
      arguments: [s.id, s.updated_at],
    };
    item.show();
  }
  for (const [id, item] of items) {
    if (!seen.has(id)) {
      item.dispose();
      items.delete(id);
      reviewedAt.delete(id);
    }
  }

  // Bar → extension focus relay (decision 018). If the floating bar asked to focus a
  // session that lives in THIS window (i.e. one we just rendered), jump to its tab
  // via the popup-free in-editor command. Keyed by requested_at so each click fires
  // once; a request for another window's session is left for that window to handle.
  const req = readFocusRequest();
  if (req && req.requested_at > lastFocusReq && seen.has(req.session_id)) {
    lastFocusReq = req.requested_at;
    vscode.commands
      .executeCommand("claude-vscode.editor.open", req.session_id, undefined, vscode.ViewColumn.Active)
      .then(undefined, () => {
        /* command absent (Claude Code not installed here) — ignore */
      });
  }
}

// Install the hooks only if they aren't already present, so multiple windows
// don't concurrently rewrite settings.json. (The standalone app installs these
// too; both converge on ~/.claude/status/report.sh.)
function ensureHooks(context: vscode.ExtensionContext): void {
  const script = path.join(statusDir(), "report.sh");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    if (fs.existsSync(script) && fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const cmd = s?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
      if (typeof cmd === "string" && cmd.includes("report.sh")) return; // already installed
    }
  } catch {
    /* fall through and install */
  }

  try {
    const dir = statusDir();
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const bundled = path.join(context.extensionPath, "report.sh");
    fs.writeFileSync(script, fs.readFileSync(bundled, "utf8"));
    fs.chmodSync(script, 0o755);

    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
      const txt = fs.readFileSync(settingsPath, "utf8");
      const bak = settingsPath + ".claudestatus-bak";
      if (!fs.existsSync(bak)) fs.writeFileSync(bak, txt);
      try {
        settings = JSON.parse(txt);
      } catch {
        settings = {};
      }
    } else {
      fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true });
    }
    if (typeof settings !== "object" || settings === null) settings = {};
    if (typeof settings.hooks !== "object" || settings.hooks === null) settings.hooks = {};

    const SIMPLE = [
      "SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "StopFailure",
      "SubagentStart", "SubagentStop",
    ];
    const TOOL = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
    const add = (event: string, matcher: boolean) => {
      const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const kept = arr.filter((e: any) => !JSON.stringify(e).includes("report.sh"));
      const hook = { type: "command", command: `${script} ${event}` };
      kept.push(matcher ? { matcher: "*", hooks: [hook] } : { hooks: [hook] });
      settings.hooks[event] = kept;
    };
    SIMPLE.forEach((e) => add(e, false));
    TOOL.forEach((e) => add(e, true));
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

export function activate(context: vscode.ExtensionContext): void {
  if (vscode.workspace.getConfiguration("claudestatus").get<boolean>("ensureHooks", true)) {
    ensureHooks(context);
  }

  // Seed the focus-relay watermark to any request already on disk so we don't replay
  // a stale click when this window (re)loads. Only requests made after now fire.
  const seedReq = readFocusRequest();
  lastFocusReq = seedReq ? seedReq.requested_at : -1;

  context.subscriptions.push(
    vscode.commands.registerCommand("claudestatus.focusSession", async (id: string, updatedAt?: number) => {
      // Acknowledge the finished turn (keyed by its finish time), then reflect it
      // immediately — the "done" item drops to dim idle (decision 014).
      if (typeof updatedAt === "number") {
        reviewedAt.set(id, updatedAt);
        refresh();
      }
      // Call Claude Code's own open command directly (this is what its vscode://
      // deep-link handler calls internally). Focuses the session's tab with no
      // URI-consent prompt. Fall back to the deep link if the command is absent.
      try {
        await vscode.commands.executeCommand(
          "claude-vscode.editor.open",
          id,
          undefined,
          vscode.ViewColumn.Active
        );
      } catch {
        vscode.env.openExternal(
          vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${id}`)
        );
      }
    })
  );

  refresh();
  const timer = setInterval(refresh, POLL_MS);
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh()),
    { dispose: () => items.forEach((i) => i.dispose()) }
  );
}

export function deactivate(): void {
  items.forEach((i) => i.dispose());
  items.clear();
}

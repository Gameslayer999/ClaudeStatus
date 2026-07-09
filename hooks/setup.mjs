#!/usr/bin/env node
// ClaudeStatus — install/uninstall the real status hooks (report.sh).
//
// Merges the status hooks into the user's ~/.claude/settings.json WITHOUT
// clobbering existing settings or hooks (Agent Guideline #3). Idempotent
// (re-running install never duplicates), reversible (one-time backup + a clean
// uninstall that removes exactly our entries).
//
//   node hooks/setup.mjs install
//   node hooks/setup.mjs uninstall
//   node hooks/setup.mjs status

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');
const CLAUDE_BACKUP = CLAUDE_SETTINGS + '.claudestatus-bak';
const CODEX_HOOKS = join(homedir(), '.codex', 'hooks.json');
const CODEX_BACKUP = CODEX_HOOKS + '.claudestatus-bak';
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HOOKS_DIR, 'report.sh');

// The exact events the signal layer consumes (verified contract, DECISIONS.md #006).
// Tool-scoped events take a "*" matcher (match all tools); lifecycle events take none.
const SIMPLE = [
  'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'StopFailure',
  'SubagentStart', 'SubagentStop',
];
const TOOL = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
const CODEX_SIMPLE = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop'];
const CODEX_TOOL = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];

const marker = (entry) => JSON.stringify(entry).includes('report.sh');
const load = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
const save = (path, s) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n');
};

function installHooks(path, backup, simpleEvents = SIMPLE, toolEvents = TOOL) {
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  const s = load(path);
  s.hooks ??= {};
  const add = (event, withMatcher) => {
    const kept = (s.hooks[event] ?? []).filter((e) => !marker(e)); // drop stale entries
    const hook = { type: 'command', command: `${REPORT} ${event}` };
    kept.push(withMatcher ? { matcher: '*', hooks: [hook] } : { hooks: [hook] });
    s.hooks[event] = kept;
  };
  simpleEvents.forEach((e) => add(e, false));
  toolEvents.forEach((e) => add(e, true));
  save(path, s);
}

function uninstallHooks(path) {
  const s = load(path);
  if (s.hooks) {
    for (const event of Object.keys(s.hooks)) {
      s.hooks[event] = (s.hooks[event] ?? []).filter((e) => !marker(e));
      if (s.hooks[event].length === 0) delete s.hooks[event];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
  }
  save(path, s);
}

function hookEvents(path) {
  const s = load(path);
  return s.hooks
    ? Object.entries(s.hooks).filter(([, arr]) => (arr ?? []).some(marker)).map(([e]) => e)
    : [];
}

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  installHooks(CLAUDE_SETTINGS, CLAUDE_BACKUP);
  installHooks(CODEX_HOOKS, CODEX_BACKUP, CODEX_SIMPLE, CODEX_TOOL);
  console.log(`Installed ClaudeStatus hooks for ${SIMPLE.length + TOOL.length} events into ${CLAUDE_SETTINGS}`);
  console.log(`Installed ClaudeStatus Codex hooks for ${CODEX_SIMPLE.length + CODEX_TOOL.length} events into ${CODEX_HOOKS}`);
  console.log(`Backups: ${CLAUDE_BACKUP}, ${CODEX_BACKUP}`);
} else if (cmd === 'uninstall') {
  uninstallHooks(CLAUDE_SETTINGS);
  uninstallHooks(CODEX_HOOKS);
  console.log(`Removed ClaudeStatus hooks from ${CLAUDE_SETTINGS}`);
  console.log(`Removed ClaudeStatus Codex hooks from ${CODEX_HOOKS}`);
} else {
  const claudeEvents = hookEvents(CLAUDE_SETTINGS);
  const codexEvents = hookEvents(CODEX_HOOKS);
  console.log(claudeEvents.length ? `Claude hooks active on: ${claudeEvents.join(', ')}` : 'Claude hooks not installed');
  console.log(codexEvents.length ? `Codex hooks active on: ${codexEvents.join(', ')}` : 'Codex hooks not installed');
}

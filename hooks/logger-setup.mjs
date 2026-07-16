#!/usr/bin/env node
// AgentStatus — Milestone 1 logger install/uninstall.
//
// Merges the event logger into the user's ~/.claude/settings.json WITHOUT
// clobbering existing settings or hooks (Agent Guideline #3). Idempotent:
// re-running install never duplicates entries. Reversible: a one-time backup
// is written, and `uninstall` removes exactly our entries.
//
//   node hooks/logger-setup.mjs install
//   node hooks/logger-setup.mjs uninstall
//   node hooks/logger-setup.mjs status

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const BACKUP = SETTINGS + '.agentstatus-bak';
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const LOGGER = join(HOOKS_DIR, 'log-events.sh');

// Events to capture. Tool events take a "*" matcher (match all tools); the rest
// are session/lifecycle events with no matcher. This list is deliberately broad
// (incl. unverified names) — the whole point is to discover which actually fire.
const SIMPLE = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop',
  'SubagentStart', 'SubagentStop', 'Notification', 'PreCompact', 'PostCompact',
  'StopFailure', 'Elicitation', 'PermissionRequest', 'PermissionDenied',
];
const TOOL = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

const marker = (entry) => JSON.stringify(entry).includes('log-events.sh');

function load() {
  return existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {};
}
function save(s) {
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  if (existsSync(SETTINGS) && !existsSync(BACKUP)) copyFileSync(SETTINGS, BACKUP);
  const s = load();
  s.hooks ??= {};
  const add = (event, withMatcher) => {
    const kept = (s.hooks[event] ?? []).filter((e) => !marker(e)); // drop stale logger entries
    const hook = { type: 'command', command: `${LOGGER} ${event}` };
    kept.push(withMatcher ? { matcher: '*', hooks: [hook] } : { hooks: [hook] });
    s.hooks[event] = kept;
  };
  SIMPLE.forEach((e) => add(e, false));
  TOOL.forEach((e) => add(e, true));
  save(s);
  console.log(`Installed logger for ${SIMPLE.length + TOOL.length} events into ${SETTINGS}`);
  console.log(`Backup: ${BACKUP}`);
} else if (cmd === 'uninstall') {
  const s = load();
  if (s.hooks) {
    for (const event of Object.keys(s.hooks)) {
      s.hooks[event] = (s.hooks[event] ?? []).filter((e) => !marker(e));
      if (s.hooks[event].length === 0) delete s.hooks[event];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
  }
  save(s);
  console.log(`Removed AgentStatus logger entries from ${SETTINGS}`);
} else {
  const s = load();
  const events = s.hooks
    ? Object.entries(s.hooks)
        .filter(([, arr]) => (arr ?? []).some(marker))
        .map(([e]) => e)
    : [];
  console.log(events.length ? `Logger active on: ${events.join(', ')}` : 'Logger not installed');
}

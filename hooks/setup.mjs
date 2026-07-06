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

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = join(homedir(), '.claude', 'settings.json');
const BACKUP = SETTINGS + '.claudestatus-bak';
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HOOKS_DIR, 'report.sh');

// The exact events the signal layer consumes (verified contract, DECISIONS.md #006).
// Tool-scoped events take a "*" matcher (match all tools); lifecycle events take none.
const SIMPLE = [
  'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'StopFailure',
  'SubagentStart', 'SubagentStop',
];
const TOOL = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];

const marker = (entry) => JSON.stringify(entry).includes('report.sh');
const load = () => (existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {});
const save = (s) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  if (existsSync(SETTINGS) && !existsSync(BACKUP)) copyFileSync(SETTINGS, BACKUP);
  const s = load();
  s.hooks ??= {};
  const add = (event, withMatcher) => {
    const kept = (s.hooks[event] ?? []).filter((e) => !marker(e)); // drop stale entries
    const hook = { type: 'command', command: `${REPORT} ${event}` };
    kept.push(withMatcher ? { matcher: '*', hooks: [hook] } : { hooks: [hook] });
    s.hooks[event] = kept;
  };
  SIMPLE.forEach((e) => add(e, false));
  TOOL.forEach((e) => add(e, true));
  save(s);
  console.log(`Installed ClaudeStatus hooks for ${SIMPLE.length + TOOL.length} events into ${SETTINGS}`);
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
  console.log(`Removed ClaudeStatus hooks from ${SETTINGS}`);
} else {
  const s = load();
  const events = s.hooks
    ? Object.entries(s.hooks).filter(([, arr]) => (arr ?? []).some(marker)).map(([e]) => e)
    : [];
  console.log(events.length ? `Status hooks active on: ${events.join(', ')}` : 'Status hooks not installed');
}

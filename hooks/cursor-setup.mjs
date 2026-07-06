#!/usr/bin/env node
// ClaudeStatus — install/uninstall the native Cursor status hooks (decision 015).
//
// Cursor already runs report.sh via its Claude-compat bridge (it reads
// ~/.claude/settings.json), which covers running/idle/error/remove. But the bridge
// silently drops the events we need for subagent badges and tool-failure calibration
// ("SubagentStart"/"PostToolUseFailure" log as unknown/ignored). This installer adds
// those back by registering report.sh natively in ~/.cursor/hooks.json for Cursor's
// own event names — so Cursor sessions reach full parity with VS Code (minus blocked,
// which Cursor exposes no event for).
//
// Points at the app-maintained copy ~/.claude/status/report.sh — the SAME script the
// Claude bridge calls — so both paths run identical logic. Merges WITHOUT clobbering
// existing Cursor hooks (Agent Guideline #3): idempotent (never duplicates), reversible
// (one-time backup + a clean uninstall that removes exactly our entries).
//
//   node hooks/cursor-setup.mjs install
//   node hooks/cursor-setup.mjs uninstall
//   node hooks/cursor-setup.mjs status

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOKS_JSON = join(homedir(), '.cursor', 'hooks.json');
const BACKUP = HOOKS_JSON + '.claudestatus-bak';
const REPORT = join(homedir(), '.claude', 'status', 'report.sh');

// Only the events Cursor's Claude bridge does NOT forward. Everything else
// (sessionStart/beforeSubmitPrompt/postToolUse/stop/sessionEnd → running/idle/error/
// remove) already reaches report.sh through the bridge, so registering it here too
// would just double-fire. Cursor event names are camelCase; report.sh normalizes them.
const EVENTS = ['subagentStart', 'subagentStop', 'postToolUseFailure'];

const marker = (entry) => JSON.stringify(entry).includes('report.sh');

function load() {
  if (!existsSync(HOOKS_JSON)) return { version: 1, hooks: {} };
  const j = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  j.version ??= 1;
  j.hooks ??= {};
  return j;
}
const save = (j) => writeFileSync(HOOKS_JSON, JSON.stringify(j, null, 2) + '\n');

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  if (existsSync(HOOKS_JSON) && !existsSync(BACKUP)) copyFileSync(HOOKS_JSON, BACKUP);
  const j = load();
  for (const event of EVENTS) {
    const kept = (j.hooks[event] ?? []).filter((e) => !marker(e)); // drop stale entries
    kept.push({ command: `${REPORT} ${event}` });
    j.hooks[event] = kept;
  }
  save(j);
  console.log(`Installed ClaudeStatus native Cursor hooks for ${EVENTS.length} events into ${HOOKS_JSON}`);
  if (!existsSync(REPORT)) console.log(`WARNING: ${REPORT} does not exist yet — launch/rebuild the app so it writes the installed report.sh.`);
} else if (cmd === 'uninstall') {
  if (!existsSync(HOOKS_JSON)) { console.log('No ~/.cursor/hooks.json — nothing to remove'); process.exit(0); }
  const j = load();
  for (const event of Object.keys(j.hooks)) {
    j.hooks[event] = (j.hooks[event] ?? []).filter((e) => !marker(e));
    if (j.hooks[event].length === 0) delete j.hooks[event];
  }
  save(j);
  console.log(`Removed ClaudeStatus native Cursor hooks from ${HOOKS_JSON}`);
} else {
  const j = load();
  const events = Object.entries(j.hooks)
    .filter(([, arr]) => (arr ?? []).some(marker)).map(([e]) => e);
  console.log(events.length ? `Native Cursor hooks active on: ${events.join(', ')}` : 'Native Cursor hooks not installed');
}

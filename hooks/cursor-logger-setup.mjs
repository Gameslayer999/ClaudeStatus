#!/usr/bin/env node
// ClaudeStatus — Cursor logger install/uninstall (temporary verification tool).
//
// Merges the Cursor event logger into ~/.cursor/hooks.json WITHOUT clobbering
// existing hooks (Agent Guideline #3). Idempotent: re-running install never
// duplicates entries. Reversible: a one-time backup is written, and `uninstall`
// removes exactly our entries. Mirrors hooks/logger-setup.mjs (the Claude Code
// logger installer), adapted to Cursor's hooks.json schema (version 1).
//
//   node hooks/cursor-logger-setup.mjs install
//   node hooks/cursor-logger-setup.mjs uninstall
//   node hooks/cursor-logger-setup.mjs status

import { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_JSON = join(homedir(), '.cursor', 'hooks.json');
const BACKUP = HOOKS_JSON + '.claudestatus-bak';
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const LOGGER = join(HOOKS_DIR, 'cursor-log-events.sh');

// Observational / lifecycle events only — deliberately NO gating before*-execution
// events (beforeShellExecution, beforeMCPExecution, beforeReadFile, preToolUse) —
// so the logger can never delay or block the user's live Cursor agent
// (Agent Guideline #3). postToolUse covers the "running" signal + identity/cwd
// that preToolUse would, observationally. This list is deliberately broad
// (incl. unverified names) — the point is to discover which actually fire.
const EVENTS = [
  'sessionStart', 'sessionEnd', 'stop',
  'beforeSubmitPrompt',
  'postToolUse', 'postToolUseFailure',
  'subagentStart', 'subagentStop',
  'afterShellExecution', 'afterFileEdit', 'afterAgentResponse', 'preCompact',
];

const marker = (entry) => JSON.stringify(entry).includes('cursor-log-events.sh');

function load() {
  if (!existsSync(HOOKS_JSON)) return { version: 1, hooks: {} };
  const j = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  j.version ??= 1;
  j.hooks ??= {};
  return j;
}
function save(j) {
  writeFileSync(HOOKS_JSON, JSON.stringify(j, null, 2) + '\n');
}

const cmd = process.argv[2] || 'status';

if (cmd === 'install') {
  try { chmodSync(LOGGER, 0o755); } catch {}
  if (existsSync(HOOKS_JSON) && !existsSync(BACKUP)) copyFileSync(HOOKS_JSON, BACKUP);
  const j = load();
  for (const event of EVENTS) {
    const kept = (j.hooks[event] ?? []).filter((e) => !marker(e)); // drop stale logger entries
    kept.push({ command: `${LOGGER} ${event}` });
    j.hooks[event] = kept;
  }
  save(j);
  console.log(`Installed Cursor logger for ${EVENTS.length} events into ${HOOKS_JSON}`);
  if (existsSync(BACKUP)) console.log(`Backup: ${BACKUP}`);
} else if (cmd === 'uninstall') {
  if (!existsSync(HOOKS_JSON)) { console.log('No ~/.cursor/hooks.json — nothing to remove'); process.exit(0); }
  const j = load();
  for (const event of Object.keys(j.hooks)) {
    j.hooks[event] = (j.hooks[event] ?? []).filter((e) => !marker(e));
    if (j.hooks[event].length === 0) delete j.hooks[event];
  }
  save(j);
  console.log(`Removed ClaudeStatus Cursor logger entries from ${HOOKS_JSON}`);
} else {
  const j = load();
  const events = Object.entries(j.hooks)
    .filter(([, arr]) => (arr ?? []).some(marker))
    .map(([e]) => e);
  console.log(events.length ? `Cursor logger active on: ${events.join(', ')}` : 'Cursor logger not installed');
}

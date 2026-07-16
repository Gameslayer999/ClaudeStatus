# CLAUDE.md — AgentStatus Onboarding Guide

> Read this file completely before taking any action on this project.
> This file is the single source of truth for any new agent continuing development.

---

## Project Overview

**AgentStatus** is a lightweight, always-on-top status bar that shows the live state of
every open Claude Code session as a small row of colored lights the user can position
anywhere on screen. Each light corresponds to one Claude Code session (one VS Code tab):

- 🟢 **green** — running (actively working on a turn)
- 🟠 **orange** — blocked (waiting for user input: a permission prompt or a question)
- ⚪ **gray** — idle (turn finished / ready for the next prompt)
- 🔴 **red** — error (a turn or tool failed)

The system has two layers, decided independently:

1. **Signal layer** — Claude Code **hooks** (registered in `settings.json`) fire on session
   lifecycle events. Each hook receives a JSON payload on stdin (`session_id`, `cwd`,
   `transcript_path`, event name) and writes that session's current state into a shared
   JSON status file (`~/.claude/status/sessions.json`), keyed by `session_id`.
2. **Display layer** — a **Tauri** app (Rust shell + web UI) renders a borderless,
   always-on-top, drag-to-position window. It watches the status file and draws one
   colored light per active session, labeled by project folder.

**Key properties:**
- **Glanceable** — the whole point is to know, at a glance and without switching windows,
  which of several concurrent Claude sessions need attention.
- **Non-intrusive** — hooks must be fast and must never slow down or break the user's
  Claude Code sessions. The display is small, floating, and stays out of the way.
- **Self-installing** — a single script wires the hooks into the user's Claude Code
  config idempotently and reversibly; no manual setup steps.

> **Status:** Planning complete, architecture decided, no code yet. See `NEXT_STEPS.md`
> for the current build queue and `DECISIONS.md` for the rationale behind the stack.

---

## ⚠ Agent Guidelines — Read First

These rules apply to every agent working on this project:

**0. Always build toward the final product.** Keep the end goal — the glanceable,
always-on-top light bar reflecting live Claude Code session status in the Project Overview
— in mind at all times. Before starting any task, be able to state how it moves the project
toward that final product. If you don't understand how the current piece factors into the
end result — why it exists, which layer it serves, what depends on it — **stop and figure
out why before writing code.** Ask the user if the connection is still unclear. Never build
something just because it was requested or because it seems locally reasonable; a task that
doesn't advance the final product, or that you can't tie back to it, is a signal to pause
and reassess, not to proceed.

1. **Get approval before large architecture changes.** If a decision affects file
   structure, the status-file schema, the hook contract (which events map to which state),
   the display technology, or the installer's behavior — stop and explain the options to
   the user before writing any code.

2. **Flag better alternatives.** If you see a simpler, cheaper, or more robust way to
   accomplish something than what's currently planned, say so. Don't just silently
   implement what was previously decided if there's a meaningfully better path.

3. **Never break or slow down the user's Claude Code.** This tool instruments the user's
   real, working Claude Code sessions. Hooks run inside those sessions:
   - **Hooks must be fast and non-blocking.** A hook must do the minimum work (write a
     small JSON update) and exit immediately. Never make a hook wait on network, locks
     held by the display app, or anything that could stall the user's turn.
   - **Hooks must never fail the session.** A hook that errors must fail silently (exit 0,
     swallow its own errors) rather than surface noise into the user's Claude Code.
   - **Config changes must be reversible.** The installer edits the user's Claude Code
     `settings.json`; it must be idempotent, must not clobber existing hooks/settings, and
     must be cleanly uninstallable.

4. **Verify hook behavior against the installed version, don't assume it.** Claude Code's
   hook events and payloads are version-dependent. Before building logic on top of an
   event name or payload field, confirm it actually fires with the expected shape on the
   user's installed version (log real events from a real session). Treat doc-sourced event
   names as unverified until observed.

5. **Minimize what you read and store from sessions.** Session `cwd` paths, transcript
   contents, and prompt text can be sensitive. Store only what the lights need
   (`session_id`, coarse state, a short label, a timestamp). Do not read transcript bodies
   or copy prompt/response content into the status file unless a feature genuinely requires
   it — and flag it if one does.

6. **Test incrementally.** Don't write hundreds of lines of new code and ask the user to
   test it all at once. Build in small, verifiable steps (hooks logging → status file →
   window shell → lights).

7. **Preserve existing behaviour.** When changing code, keep its observable behaviour the
   same unless the user explicitly asks you to change it. Bug fixes, refactors, and
   performance work should fix the defect without altering inputs, outputs, side effects,
   or interfaces that callers rely on. If you believe a behaviour change is warranted, stop
   and propose it first — don't fold it silently into an unrelated change.

8. **Everything must be replicable — no one-off manual steps.** If a task required human
   intervention once (hand-editing `settings.json`, creating the status directory,
   registering a hook, capturing a window position), capture it in a single re-runnable
   script before considering the task done. Doing it a second time should mean running one
   script, not repeating the manual steps. Scripts must be idempotent and safe to re-run in
   any system state. Manual intervention is a bug to be scripted away, not a workflow.

9. **Record every decision in `DECISIONS.md`.** Any significant choice — architecture,
   tooling, the status-file schema, the event→state mapping, the display stack, or a
   reversal of a prior decision — must be appended to `DECISIONS.md` with its context, the
   options considered, the choice, and the reasoning. Update the Decision Index there too.
   Code captures *what* the system does; `DECISIONS.md` captures *why*. If you make a
   decision and don't log it, the task isn't finished.

10. **Keep `NEXT_STEPS.md` current.** At the end of every session where you add, change, or
    remove functionality, update `NEXT_STEPS.md`:
    - Move finished work to **Recently completed** (with date).
    - Add newly discovered work to **Now**, **Next**, or **Later**.
    - Refresh **Current state** if something material changed.
    - Record unresolved choices in **Decisions needed** (then log the decision in
      `DECISIONS.md` once the user chooses).
    Read `NEXT_STEPS.md` at the start of each session to pick up where the last agent left
    off. If the task isn't finished, the next-steps update isn't finished either.

11. **Be precise, descriptive, and concise.** Say exactly what happened — no vague
    summaries, no hand-waving. This applies to everything: user-facing messages, logs,
    commit messages, code comments, and status updates. Prefer the specific fact over a
    general impression; cut filler that doesn't help someone act on the information. When
    something fails — in the app, a hook, or the installer — report the exact error
    (message, code, or observable symptom), what triggered it, and the root cause once you
    know it. Do not say "something went wrong" when you can state what actually failed and
    why.

12. **Keep local/user data out of git.** The status file, any hook logs, and the user's
    Claude Code config are local runtime state, not source. `.gitignore` must cover the
    status directory, logs, and build artifacts, and none of it should ever be staged.
    Before any commit, verify with `git status` that no runtime state, session data, or
    user paths appear.

---

## UI Design Principles

These rules apply to the AgentStatus display — the light bar itself and any settings
surface it grows.

1. **Glanceable in under a second.** The entire value is reading state at a glance. Colors
   must be unambiguous and consistent; a user should never have to think about what a light
   means. Don't add chrome, labels, or animation that competes with the one signal that
   matters — which sessions need attention.

2. **Attention states must be obvious.** Orange (blocked) and red (error) are the states a
   user acts on. They must stand out clearly from green/gray — via color and, where it
   helps, motion (e.g. a gentle pulse on blocked) — so a session waiting on the user is
   never missed.

3. **A light leads straight to the session.** If clicking a light does anything, it must
   take the user directly to that Claude Code session (e.g. focus/open via
   `vscode://anthropic.claude-code/open?session=<id>`), not to a menu or a detour. The
   thing you look at to see a problem should be the thing you click to go fix it.

4. **Never show a stale or lying light.** A light must reflect the session's real current
   state. If a session dies without a clean shutdown event, detect staleness (heartbeat
   timeout) and dim/remove the light rather than leave a green light on a dead session. A
   wrong light is worse than no light.

5. **Labels are precise and minimal.** Whatever identifies a light (hover label, tooltip)
   should say exactly what the user needs to tell sessions apart — the project folder, and
   if needed a short session title — nothing more. Prefer the specific fact over filler.

---

## AI Coding Guidelines (Karpathy)

Follow these principles on every coding task. They complement the Agent Guidelines above
and take precedence over default model instincts toward over-building.

### 1. Think Before Coding

- **Never assume blindly.** If a requirement has multiple interpretations, ask for
  clarification instead of silently guessing.
- **Surface confusion.** State assumptions explicitly and name what is unclear before
  writing a single line of code.
- **Push back.** If a request is technically overcomplicated or redundant, suggest a
  simpler approach before implementing it.

### 2. Simplicity First

- **Write minimum code.** Do not add unrequested features, speculative
  "future-proofing," or single-use abstractions.
- **Ruthless compression.** If 50 lines solve the problem, 200 lines are unacceptable.
- **Avoid over-configurability.** Do not add configurations or flexibilities unless they
  were explicitly requested.

### 3. Surgical Changes

- **Touch only what is necessary.** Modify strictly the lines mandatory for the current
  task.
- **No drive-by refactoring.** Do not improve adjacent formatting, comments, or refactor
  existing code that is not broken.
- **Clean up only your own mess.** Remove unused variables or imports that your own changes
  introduced; leave pre-existing dead code untouched.

### 4. Goal-Driven Execution

- **Use verifiable success criteria.** Turn vague instructions like "fix the bug" into
  declarative goals: e.g. write a test that reproduces the bug, then make it pass.
- **Tighten the leash.** Work from a clear objective, boundaries, and metric — then loop
  until met. Weak criteria ("make it work") inevitably require human intervention.

---

## Agent Decision Framework

When you encounter a choice during development, follow this process:

1. **Is it a small implementation detail?** (variable name, minor refactor, light spacing,
   log formatting)
   → Decide and implement. No approval needed.

2. **Does it affect the status-file schema, the event→state mapping, the hook contract, the
   display stack, or how the installer modifies the user's config?**
   → Stop. Present a table of options with pros/cons and your recommendation.
   → Wait for explicit user approval before writing code.

3. **Is there an easier way than what's planned?**
   → Say so before implementing the planned approach. Example:
   *"The plan calls for X, but Y would achieve the same result with less code and no
   additional dependencies. My recommendation is Y — want me to proceed that way?"*

4. **Would the action modify the user's Claude Code environment or run inside their live
   sessions?** (editing `settings.json`, registering a hook)
   → Respect Agent Guideline #3: idempotent, reversible, non-blocking, fail-silent. Test
   against a throwaway config or a real session you're watching before shipping it as the
   installer's default.

---

## Quick Start Checklist for a New Agent

- [ ] Read this entire file
- [ ] Read `NEXT_STEPS.md` — current build queue and blockers
- [ ] Read `DECISIONS.md` for architecture rationale
- [ ] Confirm the current state of the project with the user
- [ ] Ask the user what specific task they want to work on today
- [ ] Never ship a hook or installer change that could block, slow, or break the user's
      Claude Code sessions (Agent Guideline #3)
- [ ] Verify hook event names/payloads against the installed Claude Code version before
      relying on them (Agent Guideline #4)
- [ ] Never stage or commit runtime state, session data, or user paths — confirm
      `.gitignore` covers new data paths (Agent Guideline #12)
- [ ] Before ending the session: update `NEXT_STEPS.md` if anything changed
      (Agent Guideline #10)

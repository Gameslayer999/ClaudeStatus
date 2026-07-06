// ClaudeStatus — frontend. Polls the Rust `list_sessions` command and renders
// one light per session, sizing the window to hug the bar so the transparent
// area never blocks clicks to apps behind it. Dots are reconciled in place (not
// rebuilt each poll) so hovering a light never dismisses its tooltip.

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
// LogicalSize lives in the dpi namespace in Tauri v2; fall back just in case.
const LogicalSize =
  (window.__TAURI__.dpi && window.__TAURI__.dpi.LogicalSize) ||
  (window.__TAURI__.window && window.__TAURI__.window.LogicalSize);

const POLL_MS = 1000;
const AUTO_RESIZE = true;
const MIN_W = 32; // never shrink below a grabbable pill
const MIN_H = 30;

const appWindow = getCurrentWindow();
const dots = new Map(); // session id -> dot element
let emptyEl = null;

function shortId(id) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// "3 subagents: general-purpose ×2, Explore" (grouped by type with counts).
function subSummary(subs) {
  if (!subs || subs.length === 0) return "";
  const counts = {};
  for (const t of subs) counts[t] = (counts[t] || 0) + 1;
  const parts = Object.entries(counts).map(([t, c]) => (c > 1 ? `${t} ×${c}` : t));
  return `${subs.length} subagent${subs.length > 1 ? "s" : ""}: ${parts.join(", ")}`;
}

// The hover tooltip: name — state, the task, active subagents, then the activity.
function titleFor(s) {
  const lines = [`${s.label || shortId(s.id)} — ${s.state}`];
  if (s.task) lines.push(`↳ ${s.task}`);
  const subs = subSummary(s.subagents);
  if (subs) lines.push(subs);
  if (s.detail) lines.push(s.detail);
  return lines.join("\n");
}

function render(sessions) {
  const lights = document.getElementById("lights");
  let sizeChanged = false;

  if (sessions.length === 0) {
    for (const [id, el] of dots) {
      el.remove();
      dots.delete(id);
      sizeChanged = true;
    }
    if (!emptyEl) {
      emptyEl = document.createElement("div");
      emptyEl.className = "dot empty";
      emptyEl.title = "No active Claude Code sessions";
      emptyEl.setAttribute("data-tauri-drag-region", "");
      lights.appendChild(emptyEl);
      sizeChanged = true;
    }
    if (sizeChanged) resizeToContent();
    return;
  }
  if (emptyEl) {
    emptyEl.remove();
    emptyEl = null;
    sizeChanged = true;
  }

  const seen = new Set();
  sessions.forEach((s, i) => {
    seen.add(s.id);
    let el = dots.get(s.id);
    if (!el) {
      el = document.createElement("div");
      // Click jumps to the session's window; reads the latest cwd off the element
      // so it stays correct across updates. NOT a drag region → a click never drags.
      el.addEventListener("click", () => focusSession(el._cwd));
      dots.set(s.id, el);
      sizeChanged = true;
    }
    el._cwd = s.cwd;
    // Only touch the DOM when something actually changed, so an open tooltip
    // (and the hover) isn't disrupted every poll.
    const cls = `dot ${s.state}`;
    if (el.className !== cls) el.className = cls;
    const title = titleFor(s);
    if (el.title !== title) el.title = title;
    // Subagent count badge.
    const n = (s.subagents || []).length;
    let badge = el.firstElementChild;
    if (n > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "badge";
        el.appendChild(badge);
      }
      const txt = String(n);
      if (badge.textContent !== txt) badge.textContent = txt;
    } else if (badge) {
      badge.remove();
    }
    // Keep DOM order matching session order.
    const ref = lights.children[i];
    if (ref !== el) lights.insertBefore(el, ref || null);
  });

  for (const [id, el] of dots) {
    if (!seen.has(id)) {
      el.remove();
      dots.delete(id);
      sizeChanged = true;
    }
  }

  if (sizeChanged) resizeToContent();
}

async function resizeToContent() {
  if (!AUTO_RESIZE || !LogicalSize) return;
  // Wait for layout+paint so we never measure a 0-width bar (which shrank the
  // window to nothing before the content rendered).
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const bar = document.getElementById("bar");
  const rect = bar.getBoundingClientRect();
  // +BADGE_PAD so a subagent badge overflowing the last dot's corner isn't clipped.
  const BADGE_PAD = 6;
  const w = Math.max(MIN_W, Math.ceil(rect.width) + BADGE_PAD);
  const h = Math.max(MIN_H, Math.ceil(rect.height));
  try {
    await appWindow.setSize(new LogicalSize(w, h));
  } catch (_) {
    /* fail-silent: keep last size */
  }
}

async function focusSession(cwd) {
  if (!cwd) return;
  try {
    await invoke("focus_session", { cwd });
  } catch (_) {
    /* fail-silent */
  }
}

async function tick() {
  try {
    const sessions = await invoke("list_sessions");
    render(sessions);
  } catch (_) {
    /* backend not ready yet; try again next tick */
  }
}

window.addEventListener("DOMContentLoaded", () => {
  tick();
  setInterval(tick, POLL_MS);
});

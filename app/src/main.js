// ClaudeStatus — frontend. Polls the Rust `list_sessions` command and renders
// one light per session, sizing the window to hug the bar so the transparent
// area never blocks clicks to apps behind it. Dots are reconciled in place (not
// rebuilt each poll) so hovering a light never dismisses its tooltip.

const { invoke } = window.__TAURI__.core;
// `currentMonitor` is a module-level function in Tauri v2 (not a window method).
const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
// LogicalSize / PhysicalPosition live in the dpi namespace in Tauri v2; fall back
// to the window namespace just in case.
const LogicalSize =
  (window.__TAURI__.dpi && window.__TAURI__.dpi.LogicalSize) ||
  (window.__TAURI__.window && window.__TAURI__.window.LogicalSize);
const PhysicalPosition =
  (window.__TAURI__.dpi && window.__TAURI__.dpi.PhysicalPosition) ||
  (window.__TAURI__.window && window.__TAURI__.window.PhysicalPosition);

const POLL_MS = 1000;
const AUTO_RESIZE = true;
const MIN_W = 32; // never shrink below a grabbable pill
const MIN_H = 30;

const appWindow = getCurrentWindow();
const dots = new Map(); // session id -> dot element
let emptyEl = null;

// Display preferences (app-local; persisted in the webview's localStorage so they
// survive restarts without touching the hook-written status files). Right-clicking
// the bar toggles the settings panel.
const ORIENT_KEY = "claudestatus.orientation"; // "horizontal" | "vertical"

function currentOrientation() {
  return localStorage.getItem(ORIENT_KEY) === "vertical" ? "vertical" : "horizontal";
}

// Lay the lights out as a row or a column and highlight the matching toggle. The
// window auto-resizes to hug whichever shape results.
function applyOrientation(orient) {
  const bar = document.getElementById("bar");
  bar.classList.toggle("vertical", orient === "vertical");
  for (const btn of document.querySelectorAll("#orient-seg button")) {
    btn.classList.toggle("active", btn.dataset.orient === orient);
  }
  resizeToContent();
}

function setOrientation(orient) {
  localStorage.setItem(ORIENT_KEY, orient);
  applyOrientation(orient);
}

// Light size + per-state colors — the other display prefs, same localStorage
// pattern as orientation. Defaults mirror the CSS so a cleared/absent pref looks
// identical to the stock bar.
const SIZE_KEY = "claudestatus.dotsize";
const PAD_KEY = "claudestatus.barpad";
const COLORS_KEY = "claudestatus.colors";
const DEFAULT_SIZE = 13; // px
const DEFAULT_PAD = 9; // px, wrapper padding around the lights
const DEFAULT_COLORS = {
  running: "#2ecc71",
  blocked: "#f39c12",
  done: "#ecf0f1",
  idle: "#7f8c8d",
  error: "#e74c3c",
};

function currentSize() {
  const n = parseInt(localStorage.getItem(SIZE_KEY), 10);
  return Number.isFinite(n) ? Math.min(24, Math.max(8, n)) : DEFAULT_SIZE;
}

function currentPad() {
  const n = parseInt(localStorage.getItem(PAD_KEY), 10);
  return Number.isFinite(n) ? Math.min(20, Math.max(2, n)) : DEFAULT_PAD;
}

function currentColors() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
  } catch (_) {
    /* corrupt value → fall back to defaults */
  }
  return { ...DEFAULT_COLORS, ...saved };
}

// Push size + colors into the CSS variables on #bar (which drive dot geometry and
// every state color, including the color-mix glow) and sync the panel's inputs to
// the live values.
function applyStyle() {
  const bar = document.getElementById("bar");
  const size = currentSize();
  const pad = currentPad();
  const colors = currentColors();
  bar.style.setProperty("--dot-size", `${size}px`);
  bar.style.setProperty("--bar-pad", `${pad}px`);
  for (const [state, hex] of Object.entries(colors)) {
    bar.style.setProperty(`--c-${state}`, hex);
  }
  const range = document.getElementById("size-range");
  if (range) range.value = String(size);
  const padRange = document.getElementById("pad-range");
  if (padRange) padRange.value = String(pad);
  for (const input of document.querySelectorAll('#colors input[type="color"]')) {
    input.value = colors[input.dataset.state] || DEFAULT_COLORS[input.dataset.state];
  }
  resizeToContent(); // a size change reshapes the bar
}

function setSize(px) {
  localStorage.setItem(SIZE_KEY, String(px));
  applyStyle();
}

function setPad(px) {
  localStorage.setItem(PAD_KEY, String(px));
  applyStyle();
}

function setColor(state, hex) {
  const colors = currentColors();
  colors[state] = hex;
  localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
  applyStyle();
}

// "Reset to defaults" clears every display pref (orientation, size, colors).
function resetPrefs() {
  localStorage.removeItem(ORIENT_KEY);
  localStorage.removeItem(SIZE_KEY);
  localStorage.removeItem(PAD_KEY);
  localStorage.removeItem(COLORS_KEY);
  applyOrientation(currentOrientation());
  applyStyle();
}

// Toggle the panel while keeping the lights pinned in place. Anchor to the lights'
// current screen position, mutate the layout, resize the window to hug the new
// content, then move the window so the lights land back on that anchor. The window
// grows/shrinks around the lights — they never move. Capturing the anchor fresh each
// time means a drag while the panel is open is respected (close keeps them where
// they now are, not where they were opened).
async function toggleSettings() {
  const settings = document.getElementById("settings");
  const bar = document.getElementById("bar");
  const opening = settings.hasAttribute("hidden");
  const anchor = await lightsScreenPos();
  if (opening) {
    if (anchor) await chooseGrowthDirection(anchor); // above/below, left/right toward center
    settings.removeAttribute("hidden");
    bar.classList.add("settings-open");
  } else {
    settings.setAttribute("hidden", "");
    bar.classList.remove("settings-open", "panel-above");
    bar.style.alignItems = "";
  }
  await resizeToContent();
  await anchorLightsTo(anchor);
}

function initSettings() {
  applyOrientation(currentOrientation());
  applyStyle();
  // Right-click anywhere on the bar (including a dot) toggles the panel; suppress
  // the native context menu.
  document.getElementById("bar").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    toggleSettings();
  });
  document.getElementById("orient-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-orient]");
    if (btn) setOrientation(btn.dataset.orient);
  });
  document.getElementById("size-range").addEventListener("input", (e) => {
    setSize(parseInt(e.target.value, 10));
  });
  document.getElementById("pad-range").addEventListener("input", (e) => {
    setPad(parseInt(e.target.value, 10));
  });
  // `input` fires live as the color picker changes, so the bar previews instantly.
  document.getElementById("colors").addEventListener("input", (e) => {
    const input = e.target.closest('input[type="color"]');
    if (input) setColor(input.dataset.state, input.value);
  });
  document.getElementById("reset-btn").addEventListener("click", resetPrefs);
}

// Reviewed-state tracking (app-local; decision 014). A session that just finished
// a turn shows as "done" — a steady white attention light — until the user clicks
// it (which also jumps to the session), acknowledging that its output was seen.
// The ack is keyed by the finish time (updated_at), so the NEXT time a turn
// finishes the light re-lights on its own. This lives only in the app, never in
// the hook-written status file — the hook stays dumb and fast.
const reviewedAt = new Map(); // session id -> updated_at that was acknowledged

// A finished turn = idle with a wrap-up message. `Stop` writes a non-empty detail
// (the last assistant message); `SessionStart` forces detail="" — so detail is the
// reliable "a turn ended and there's output to review" signal (vs. a fresh idle).
function isFinishedTurn(s) {
  return s.state === "idle" && !!s.detail;
}

// The state the light actually renders: "done" for an unacknowledged finished turn,
// otherwise the raw session state (running/blocked/idle/error).
function displayState(s) {
  if (isFinishedTurn(s) && reviewedAt.get(s.id) !== s.updated_at) return "done";
  return s.state;
}

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
function titleFor(s, ds) {
  const stateText = ds === "done" ? "finished — click to acknowledge" : ds;
  const lines = [`${s.label || shortId(s.id)} — ${stateText}`];
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
      reviewedAt.delete(id);
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
      // Click acknowledges a finished turn (keyed by its finish time) AND jumps to
      // the session's window. Reads cwd/updated_at off the element so both stay
      // correct across updates. NOT a drag region → a click never drags.
      el.addEventListener("click", () => {
        if (el._updatedAt != null) reviewedAt.set(s.id, el._updatedAt);
        if (el.className === "dot done") el.className = "dot idle"; // instant feedback
        focusSession(el._cwd, el._ide, s.id);
      });
      dots.set(s.id, el);
      sizeChanged = true;
    }
    el._cwd = s.cwd;
    el._ide = s.ide;
    el._updatedAt = s.updated_at;
    // Only touch the DOM when something actually changed, so an open tooltip
    // (and the hover) isn't disrupted every poll.
    const ds = displayState(s);
    const cls = `dot ${ds}`;
    if (el.className !== cls) el.className = cls;
    const title = titleFor(s, ds);
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
      reviewedAt.delete(id);
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

// Physical screen coordinates of the #lights element's top-left corner.
async function lightsScreenPos() {
  if (!currentMonitor) return null;
  const mon = await currentMonitor();
  const scale = (mon && mon.scaleFactor) || 1;
  let pos;
  try {
    pos = await appWindow.outerPosition();
  } catch (_) {
    return null;
  }
  const r = document.getElementById("lights").getBoundingClientRect();
  return { x: pos.x + Math.round(r.left * scale), y: pos.y + Math.round(r.top * scale), scale };
}

// Move the window so #lights sits back at `anchor` (its screen position from before
// the panel opened). Layout-agnostic: it measures where the lights currently are and
// corrects the delta — so the lights never move as the panel grows/shrinks around
// them, whichever side (above/below, left/right) the panel expanded toward.
async function anchorLightsTo(anchor) {
  if (!anchor || !PhysicalPosition) return;
  let pos;
  try {
    pos = await appWindow.outerPosition();
  } catch (_) {
    return;
  }
  const r = document.getElementById("lights").getBoundingClientRect();
  const curX = pos.x + Math.round(r.left * anchor.scale);
  const curY = pos.y + Math.round(r.top * anchor.scale);
  const nx = pos.x + (anchor.x - curX);
  const ny = pos.y + (anchor.y - curY);
  if (nx !== pos.x || ny !== pos.y) {
    try {
      await appWindow.setPosition(new PhysicalPosition(nx, ny));
    } catch (_) {
      /* fail-silent */
    }
  }
}

// Pick which way the panel grows so it heads toward the screen's middle (and stays
// on-screen): panel above the lights when they're in the bottom half, below when in
// the top half; panel aligned to the lights' right edge (grows left) when they're in
// the right half, left edge (grows right) when in the left half. The lights stay put
// regardless — this only decides the direction the extra space appears.
async function chooseGrowthDirection(anchor) {
  if (!currentMonitor) return;
  const mon = await currentMonitor();
  if (!mon) return;
  const bar = document.getElementById("bar");
  const r = document.getElementById("lights").getBoundingClientRect();
  const cx = anchor.x + (r.width * anchor.scale) / 2;
  const cy = anchor.y + (r.height * anchor.scale) / 2;
  const monCx = mon.position.x + mon.size.width / 2;
  const monCy = mon.position.y + mon.size.height / 2;
  bar.classList.toggle("panel-above", cy > monCy);
  bar.style.alignItems = cx > monCx ? "flex-end" : "flex-start";
}

async function focusSession(cwd, ide, id) {
  if (!cwd) return;
  try {
    // sessionId → the extension focuses that exact session's tab (decision 019);
    // cwd/ide → the backend raises the right window. Tauri maps camelCase → snake_case.
    await invoke("focus_session", { cwd, ide: ide || "vscode", sessionId: id || "" });
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
  initSettings();
  tick();
  setInterval(tick, POLL_MS);
});

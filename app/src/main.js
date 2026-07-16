// AgentStatus — frontend. Polls the Rust `list_sessions` command and renders
// one light per session, sizing the window to hug the bar so the transparent
// area never blocks clicks to apps behind it. Dots are reconciled in place (not
// rebuilt each poll) so hovering a light never dismisses its tooltip.

const { invoke } = window.__TAURI__.core;
// `currentMonitor` / `availableMonitors` are module-level functions in Tauri v2
// (not window methods).
const { getCurrentWindow, currentMonitor, availableMonitors } = window.__TAURI__.window;
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
const ORIENT_KEY = "agentstatus.orientation"; // "horizontal" | "vertical"
const SORT_KEY = "agentstatus.sort"; // "window" | "urgency"
const POS_KEY = "agentstatus.pos"; // last #lights screen anchor {x,y,scale} (physical px), restored on launch

// Light ordering (app-local display pref, like orientation). "window" groups
// sessions that live in the same IDE window together; "urgency" surfaces the
// attention states first. Hooks expose no true per-window id (decision 006), so a
// window is proxied by its workspace folder (the session `cwd`). Sorting by the full
// cwd path clusters a workspace root with any subfolder a session `cd`'d into, and
// two windows on the SAME folder merge into one group — the accepted signal-layer
// limit, not a sort bug.
function currentSort() {
  return localStorage.getItem(SORT_KEY) === "urgency" ? "urgency" : "window";
}

// Most-urgent first (UI Principle #2). Uses the rendered displayState so a finished
// "done" turn clusters correctly, not the raw idle state.
const URGENCY_RANK = { error: 0, blocked: 1, done: 2, running: 3, idle: 4 };

// Group sessions by window: full cwd path (so subfolders sit next to their root),
// then id as a stable tiebreaker so same-window lights don't reshuffle each poll.
function byWindow(a, b) {
  const c = (a.cwd || "").localeCompare(b.cwd || "");
  if (c) return c;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Return a new, ordered array for the current sort mode. In urgency mode a light
// only moves when its own state changes; within a state it stays window-grouped.
function sortSessions(sessions) {
  const arr = sessions.slice();
  if (currentSort() === "urgency") {
    arr.sort((a, b) => {
      const r = (URGENCY_RANK[displayState(a)] ?? 9) - (URGENCY_RANK[displayState(b)] ?? 9);
      return r || byWindow(a, b);
    });
  } else {
    arr.sort(byWindow);
  }
  return arr;
}

function applySortButtons(mode) {
  for (const btn of document.querySelectorAll("#sort-seg button")) {
    btn.classList.toggle("active", btn.dataset.sort === mode);
  }
}

// Persist the choice and re-order immediately from the latest poll, so the bar (and
// the menu-bar tray) reflow without waiting for the next tick.
function setSort(mode) {
  localStorage.setItem(SORT_KEY, mode);
  applySortButtons(mode);
  latestSessions = sortSessions(latestSessions);
  render(latestSessions);
  if (currentMode() === "menubar") {
    lastTraySig = null;
    pushTrayImage();
  }
}

function currentOrientation() {
  return localStorage.getItem(ORIENT_KEY) === "vertical" ? "vertical" : "horizontal";
}

// Menu-bar mode always renders horizontally to match the menu bar (a vertical popover
// hanging off the bar looks wrong); the user's saved orientation is restored when they
// switch back to floating. Everything that lays out the lights uses this, not the raw
// saved pref.
function effectiveOrientation() {
  return currentMode() === "menubar" ? "horizontal" : currentOrientation();
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
  applyOrientation(effectiveOrientation());
}

// ── Presentation mode: floating vs. macOS menu bar (decision 024) ───────────
// Floating = the always-visible NSPanel (current behavior). Menu-bar = a tray
// item showing the lights as a generated image; clicking it reveals this same
// panel as a popover under the menu bar. The mode + the condense sub-option are
// app-local display prefs, same localStorage pattern as orientation/size.
const MODE_KEY = "agentstatus.mode"; // "floating" | "menubar"
const CONDENSE_KEY = "agentstatus.menubarcondense"; // "true" | "false"

function currentMode() {
  return localStorage.getItem(MODE_KEY) === "menubar" ? "menubar" : "floating";
}

function currentCondense() {
  return localStorage.getItem(CONDENSE_KEY) === "true";
}

// Visual-only: highlight the active Mode button and show the Condense row only in
// menu-bar mode (it's meaningless when floating). No backend call — used on first
// paint before the backend is ready.
function applyModeButtons(mode) {
  for (const btn of document.querySelectorAll("#mode-seg button")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  const crow = document.getElementById("condense-row");
  if (crow) crow.hidden = mode !== "menubar";
  // Orientation is forced horizontal in menu-bar mode, so hide its control there.
  const orow = document.getElementById("orient-row");
  if (orow) orow.hidden = mode === "menubar";
}

function applyCondenseButtons() {
  const on = currentCondense();
  for (const btn of document.querySelectorAll("#condense-seg button")) {
    btn.classList.toggle("active", (btn.dataset.condense === "true") === on);
  }
}

// Apply a mode for real: flip the tray + panel visibility in the backend, then do
// the mode-specific frontend work — floating re-anchors the panel to the saved
// position; menu-bar paints the tray from the latest sessions.
async function applyMode(mode) {
  applyModeButtons(mode);
  applyOrientation(effectiveOrientation()); // menu-bar forces horizontal; floating restores the saved pref
  try {
    await invoke("set_mode", { mode });
  } catch (_) {
    /* backend not ready yet; the next toggle / load will retry */
  }
  if (mode === "menubar") {
    lastTraySig = null; // force a repaint
    await pushTrayImage();
  } else {
    await restoreAnchor();
  }
}

function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
  applyMode(mode);
}

function setCondense(on) {
  localStorage.setItem(CONDENSE_KEY, String(on));
  applyCondenseButtons();
  lastTraySig = null; // shape changed → repaint the tray
  pushTrayImage();
}

// ── Menu-bar tray image ─────────────────────────────────────────────────────
// The webview draws the dots to an offscreen canvas and hands the pixels to Rust,
// which sets them as the tray icon — reusing displayState()/currentColors() so the
// menu bar honors the exact same per-state colors as the bar. We only push when the
// image actually changed (signature), matching the DOM reconciler's "update on
// change only" discipline.
let trayCanvas = null;
let lastTraySig = null;
let latestSessions = []; // most recent poll, so a pref change can repaint the tray

// Condense picks the single most-urgent state to show (UI Principle #2 — surface
// what needs the user first).
const TRAY_PRIORITY = ["error", "blocked", "done", "running", "idle"];

function summaryState(states) {
  for (const p of TRAY_PRIORITY) if (states.includes(p)) return p;
  return "empty";
}

// Draw the dot row (or a single condensed dot) and return RGBA pixels + dims.
// Rendered at ~2× the menu-bar height so it's crisp on retina; macOS scales the
// image down to the bar height, preserving aspect.
function drawTray(states, colors, condense) {
  const H = 44;
  const D = 22; // dot diameter
  const R = D / 2;
  const G = 12; // gap between dots
  const P = 6; // horizontal padding
  let list;
  if (condense) list = [summaryState(states)];
  else if (states.length === 0) list = ["empty"];
  else list = states;
  const N = list.length;
  const W = Math.max(D + P * 2, P * 2 + N * D + (N - 1) * G);
  if (!trayCanvas) trayCanvas = document.createElement("canvas");
  const cv = trayCanvas;
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  list.forEach((st, i) => {
    const cx = P + R + i * (D + G);
    const cy = H / 2;
    let fill = colors[st] || colors.idle;
    let alpha = 1;
    if (st === "empty") {
      fill = "#ffffff";
      alpha = 0.28;
    } else if (st === "idle") {
      alpha = 0.55; // dim acknowledged/dormant sessions, like the bar
    }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  const data = ctx.getImageData(0, 0, W, H).data;
  return { rgba: Array.from(data), width: W, height: H };
}

// Build the tray image from the latest poll and push it to Rust if it changed.
async function pushTrayImage() {
  if (currentMode() !== "menubar") return;
  const colors = currentColors();
  const condense = currentCondense();
  const states = latestSessions.map(displayState);
  const sig = JSON.stringify([states, colors, condense]);
  if (sig === lastTraySig) return;
  lastTraySig = sig;
  const img = drawTray(states, colors, condense);
  try {
    await invoke("set_tray_image", { rgba: img.rgba, width: img.width, height: img.height });
  } catch (_) {
    /* fail-silent */
  }
}

// Hide the popover (menu-bar mode) — used after clicking a light. A subsequent tray
// click re-shows it (Rust toggles on is_visible).
function hidePopover() {
  try {
    appWindow.hide();
  } catch (_) {
    /* fail-silent */
  }
}

// Drop the latched hover scale after a click hands focus to another app: no
// mouseleave ever arrives, so the dot would stay enlarged. Cleared on the next
// mousemove, i.e. as soon as the pointer's real position is known again.
function suppressHover() {
  const bar = document.getElementById("bar");
  if (!bar || bar.classList.contains("nohover")) return;
  bar.classList.add("nohover");
  document.addEventListener("mousemove", () => bar.classList.remove("nohover"), { once: true });
}

// Light size + per-state colors — the other display prefs, same localStorage
// pattern as orientation. Defaults mirror the CSS so a cleared/absent pref looks
// identical to the stock bar.
const SIZE_KEY = "agentstatus.dotsize";
const PAD_KEY = "agentstatus.barpad";
const OPACITY_KEY = "agentstatus.baropacity";
const COLORS_KEY = "agentstatus.colors";
const DEFAULT_SIZE = 13; // px
const DEFAULT_PAD = 9; // px, wrapper padding around the lights
const DEFAULT_OPACITY = 82; // percent of pill-fill alpha (matches the CSS default 0.82)
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

// Pill-fill opacity, stored as a whole percent (20–100) to match the int slider.
function currentOpacity() {
  const n = parseInt(localStorage.getItem(OPACITY_KEY), 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_OPACITY;
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
  const opacity = currentOpacity();
  const colors = currentColors();
  bar.style.setProperty("--dot-size", `${size}px`);
  bar.style.setProperty("--bar-pad", `${pad}px`);
  bar.style.setProperty("--bar-opacity", String(opacity / 100));
  for (const [state, hex] of Object.entries(colors)) {
    bar.style.setProperty(`--c-${state}`, hex);
  }
  const range = document.getElementById("size-range");
  if (range) range.value = String(size);
  const padRange = document.getElementById("pad-range");
  if (padRange) padRange.value = String(pad);
  const opacityRange = document.getElementById("opacity-range");
  if (opacityRange) opacityRange.value = String(opacity);
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

function setOpacity(pct) {
  localStorage.setItem(OPACITY_KEY, String(pct));
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
  localStorage.removeItem(SORT_KEY);
  localStorage.removeItem(SIZE_KEY);
  localStorage.removeItem(PAD_KEY);
  localStorage.removeItem(OPACITY_KEY);
  localStorage.removeItem(COLORS_KEY);
  localStorage.removeItem(MODE_KEY);
  localStorage.removeItem(CONDENSE_KEY);
  applyOrientation(effectiveOrientation());
  applySortButtons(currentSort());
  applyStyle();
  applyCondenseButtons();
  latestSessions = sortSessions(latestSessions);
  render(latestSessions);
  applyMode(currentMode()); // back to floating: shows the panel, hides the tray
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
  applyOrientation(effectiveOrientation());
  applySortButtons(currentSort());
  applyStyle();
  applyModeButtons(currentMode()); // visual only; backend mode applied after first tick
  applyCondenseButtons();
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
  document.getElementById("sort-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-sort]");
    if (btn) setSort(btn.dataset.sort);
  });
  document.getElementById("mode-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (btn) setMode(btn.dataset.mode);
  });
  document.getElementById("condense-seg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-condense]");
    if (btn) setCondense(btn.dataset.condense === "true");
  });
  document.getElementById("size-range").addEventListener("input", (e) => {
    setSize(parseInt(e.target.value, 10));
  });
  document.getElementById("pad-range").addEventListener("input", (e) => {
    setPad(parseInt(e.target.value, 10));
  });
  document.getElementById("opacity-range").addEventListener("input", (e) => {
    setOpacity(parseInt(e.target.value, 10));
  });
  // `input` fires live as the color picker changes, so the bar previews instantly.
  document.getElementById("colors").addEventListener("input", (e) => {
    const input = e.target.closest('input[type="color"]');
    if (input) setColor(input.dataset.state, input.value);
  });
  document.getElementById("reset-btn").addEventListener("click", resetPrefs);
  // Reload the webview — picks up frontend changes and recovers from any stuck
  // state without quitting/relaunching the app.
  document.getElementById("reload-btn").addEventListener("click", () => {
    window.location.reload();
  });
  // Quit the app entirely (the accessory app has no Dock/menu-bar Quit).
  document.getElementById("quit-btn").addEventListener("click", () => {
    invoke("quit_app");
  });
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
      emptyEl.title = "No active Claude Code, Codex, or Cursor sessions";
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
        suppressHover();
        if (currentMode() === "menubar") hidePopover(); // dismiss the popover on select
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
  // Skip while the panel is hidden (menu-bar mode, popover closed): the webview
  // pauses requestAnimationFrame when off-screen, so the double-rAF below would
  // never resolve. The visibilitychange handler re-runs this when the popover
  // reappears, so the panel sizes correctly on open.
  if (document.hidden) return;
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

// Magnetic snap distance (logical px) for pinning the bar flush to a monitor edge.
const SNAP_LOGICAL = 16;

// Keep the bar on-screen across ALL monitors, with soft edge magnetism. Native
// drag regions let the OS move the window freely, so on each move we correct it in
// three steps: (1) snap any window edge sitting within SNAP of a monitor edge flush
// to it — easy pinning; (2) clamp the window inside the bounding box of every
// monitor so it can't leave the outer edges, while still sliding freely across the
// shared edges between displays; (3) if the bar's center lands in a dead gap
// between mismatched monitors, pull the whole bar onto the nearest one so it can
// never be lost. Re-entrancy is safe — the corrected position is in-bounds, so the
// setPosition it triggers produces a no-op moved event.
async function clampToMonitor(pos) {
  if (!PhysicalPosition) return;
  let monitors = [];
  try {
    if (availableMonitors) monitors = await availableMonitors();
    if (!monitors.length && currentMonitor) {
      const m = await currentMonitor();
      if (m) monitors = [m];
    }
  } catch (_) {
    return;
  }
  if (!monitors.length) return;

  let size;
  try {
    size = await appWindow.outerSize();
  } catch (_) {
    return;
  }
  const w = size.width;
  const h = size.height;
  let x = pos.x;
  let y = pos.y;

  // Per-monitor rectangles (physical px) with a scale-aware snap zone.
  const rects = monitors.map((m) => ({
    l: m.position.x,
    t: m.position.y,
    r: m.position.x + m.size.width,
    b: m.position.y + m.size.height,
    snap: Math.round(SNAP_LOGICAL * (m.scaleFactor || 1)),
  }));

  // (1) Edge magnetism — snap flush to any monitor edge within its snap zone.
  for (const m of rects) {
    if (Math.abs(x - m.l) <= m.snap) x = m.l;
    if (Math.abs(x + w - m.r) <= m.snap) x = m.r - w;
    if (Math.abs(y - m.t) <= m.snap) y = m.t;
    if (Math.abs(y + h - m.b) <= m.snap) y = m.b - h;
  }

  // (2) Clamp inside the bounding box of all monitors.
  const minX = Math.min(...rects.map((m) => m.l));
  const minY = Math.min(...rects.map((m) => m.t));
  const maxX = Math.max(...rects.map((m) => m.r)) - w;
  const maxY = Math.max(...rects.map((m) => m.b)) - h;
  if (maxX >= minX) x = Math.max(minX, Math.min(x, maxX));
  if (maxY >= minY) y = Math.max(minY, Math.min(y, maxY));

  // (3) Gap guard — if the bar's center isn't on any monitor (a dead zone between
  //     mismatched displays), pull the whole bar onto the nearest monitor.
  const cx = x + w / 2;
  const cy = y + h / 2;
  const onScreen = rects.some((m) => cx >= m.l && cx < m.r && cy >= m.t && cy < m.b);
  if (!onScreen) {
    let best = rects[0];
    let bestD = Infinity;
    for (const m of rects) {
      const dx = cx < m.l ? m.l - cx : cx > m.r ? cx - m.r : 0;
      const dy = cy < m.t ? m.t - cy : cy > m.b ? cy - m.b : 0;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    x = Math.max(best.l, Math.min(x, best.r - w));
    y = Math.max(best.t, Math.min(y, best.b - h));
  }

  if (x !== pos.x || y !== pos.y) {
    try {
      await appWindow.setPosition(new PhysicalPosition(x, y));
    } catch (_) {
      /* fail-silent */
    }
  }
}

// Persist WHERE THE LIGHTS SIT on screen — not the window's top-left. The window
// grows/shrinks around the fixed lights as the settings panel opens/closes, so its
// top-left depends on panel state; restoring it onto a differently-sized window
// would shift the lights (e.g. reloading from the panel-open state). The lights'
// screen position is stable, so that's what we save and restore. localStorage lives
// in the webview data dir (keyed by bundle id), so it survives replacing the .app.
function saveAnchor(a) {
  try {
    localStorage.setItem(
      POS_KEY,
      JSON.stringify({ x: Math.round(a.x), y: Math.round(a.y), scale: a.scale })
    );
  } catch (_) {
    /* fail-silent */
  }
}

function loadAnchor() {
  try {
    const a = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.scale)) return a;
  } catch (_) {
    /* fall through */
  }
  return null;
}

// Don't persist the involuntary window moves that setSize triggers during startup
// layout — only start saving once we've restored the user's position.
let anchorReady = false;

// On any move: keep the bar on-screen, then (once ready) remember the lights' new
// screen position so a restart/rebuild reopens them here instead of recentering.
async function onWindowMoved(pos) {
  // In menu-bar mode the popover's position is tray-driven, not user-dragged — don't
  // clamp or persist it (that's a floating-mode concern; decision 022).
  if (currentMode() === "menubar") return;
  await clampToMonitor(pos);
  if (!anchorReady) return;
  const a = await lightsScreenPos();
  if (a) saveAnchor(a);
}

// Restore the saved lights position on launch (overriding the config's center):
// size the bar to its final shape, then shift the window so the lights land back on
// the saved anchor. clampToMonitor keeps it on-screen if the display setup changed.
async function restoreAnchor() {
  const saved = loadAnchor();
  if (!saved) return;
  await resizeToContent();
  await anchorLightsTo(saved);
  try {
    await clampToMonitor(await appWindow.outerPosition());
  } catch (_) {
    /* fail-silent */
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
    const sessions = sortSessions(await invoke("list_sessions"));
    latestSessions = sessions;
    render(sessions);
    if (currentMode() === "menubar") await pushTrayImage();
  } catch (_) {
    /* backend not ready yet; try again next tick */
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  initSettings();
  // Bound native drags to the monitor (can't be dragged off-screen) and remember the
  // lights' resting position. Registered before restore so restore's own moves are
  // clamped; anchorReady stays false until restore finishes so those moves aren't saved.
  if (appWindow.onMoved) {
    appWindow.onMoved(({ payload }) => onWindowMoved(payload));
  }
  // The webview pauses rAF while the panel is hidden; when the menu-bar popover
  // reappears, re-run the resize so it sizes to the current dots on open.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentMode() === "menubar") resizeToContent();
  });
  await tick(); // first render, so the bar has its real size before we anchor it
  anchorReady = true;
  // Apply the saved presentation mode: floating restores the anchor and shows the
  // panel; menu-bar hides the panel and paints the tray. (Menu-bar skips the anchor
  // restore — the popover is positioned by the tray, not the saved floating spot.)
  await applyMode(currentMode());
  setInterval(tick, POLL_MS);
});

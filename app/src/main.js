// ClaudeStatus — frontend. Polls the Rust `list_sessions` command and renders
// one light per session, sizing the window to hug the bar so the transparent
// area never blocks clicks to apps behind it.

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
// LogicalSize lives in the dpi namespace in Tauri v2; fall back just in case.
const LogicalSize =
  (window.__TAURI__.dpi && window.__TAURI__.dpi.LogicalSize) ||
  (window.__TAURI__.window && window.__TAURI__.window.LogicalSize);

const POLL_MS = 1000;
const STALE_SECONDS = 600; // no heartbeat for 10 min → treat as stale (unclean death)
const AUTO_RESIZE = true;
const MIN_W = 32; // never shrink below a grabbable pill
const MIN_H = 30;

const appWindow = getCurrentWindow();
let lastSig = "";

function shortId(id) {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function render(sessions) {
  const lights = document.getElementById("lights");
  const now = Date.now() / 1000;

  // Skip DOM work when nothing visible changed.
  const sig = sessions
    .map((s) => `${s.id}:${s.state}:${now - s.updated_at > STALE_SECONDS ? 1 : 0}`)
    .join("|");
  if (sig === lastSig) return;
  lastSig = sig;

  lights.innerHTML = "";

  if (sessions.length === 0) {
    const dot = document.createElement("div");
    dot.className = "dot empty";
    dot.title = "No active Claude Code sessions";
    dot.setAttribute("data-tauri-drag-region", "");
    lights.appendChild(dot);
  } else {
    for (const s of sessions) {
      const stale = now - s.updated_at > STALE_SECONDS;
      const dot = document.createElement("div");
      dot.className = `dot ${s.state}${stale ? " stale" : ""}`;
      dot.title = `${s.label || shortId(s.id)} — ${s.state}${stale ? " (stale)" : ""}`;
      // Whole bar is draggable for now (M3); click actions come with M6.
      dot.setAttribute("data-tauri-drag-region", "");
      lights.appendChild(dot);
    }
  }

  resizeToContent();
}

async function resizeToContent() {
  if (!AUTO_RESIZE || !LogicalSize) return;
  // Wait for layout+paint so we never measure a 0-width bar (which shrank the
  // window to nothing before the content rendered).
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const bar = document.getElementById("bar");
  const rect = bar.getBoundingClientRect();
  const w = Math.max(MIN_W, Math.ceil(rect.width));
  const h = Math.max(MIN_H, Math.ceil(rect.height));
  try {
    await appWindow.setSize(new LogicalSize(w, h));
  } catch (_) {
    /* fail-silent: keep last size */
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

// ClaudeStatus — Tauri backend.
// Reads the per-session status files written by the hook (decision 007) and
// exposes them to the frontend via the `list_sessions` command.

use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

mod install;

/// Tray icon id — used to fetch the tray (`app.tray_by_id`) from the mode/image
/// commands after it's built in `setup`.
#[cfg(target_os = "macos")]
const TRAY_ID: &str = "claudestatus";

#[derive(Serialize)]
struct SessionStatus {
    id: String,
    state: String,
    cwd: String,
    label: String,
    updated_at: i64,
    task: String,
    detail: String,
    /// Host surface ("cursor", "vscode", or "codex"), from the hook — drives click-to-focus.
    ide: String,
    /// agent_type of each currently-running subagent under this session.
    subagents: Vec<String>,
}

/// A session with no hook activity for this long is treated as dead/abandoned and
/// pruned. It self-heals: any real session re-registers on its next event. Chosen
/// long enough that a session you're actively dealing with (even blocked/errored,
/// which emit no further events while waiting) won't vanish out from under you.
const MAX_IDLE_SECS: i64 = 2 * 60 * 60;

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Epoch milliseconds — used as the focus-request token so two clicks in the same
/// second still read as distinct requests (see write_focus_request).
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Root status directory (~/.claude/status), honoring $CLAUDESTATUS_DIR (same
/// override the hook uses).
fn status_root() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDESTATUS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".claude").join("status")
}

/// Directory holding one JSON file per session (status_root/sessions).
fn sessions_dir() -> PathBuf {
    status_root().join("sessions")
}

/// Hand a specific-session focus request to the per-window VS Code extension
/// (decision 015). The floating bar can raise the right *window* itself (the IDE
/// CLI, below) but cannot focus a specific session *tab* — that needs the in-editor
/// `claude-vscode.editor.open` command, which only the extension can call. The
/// `vscode://` deep link is the only external lever and it shows a consent popup on
/// every click (verified live), so instead the bar drops the target session id here
/// and the extension (which polls the status dir) focuses the tab, popup-free.
/// `requested_at` is epoch millis so each click is a distinct request.
fn write_focus_request(session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    let dir = status_root();
    let _ = std::fs::create_dir_all(&dir);
    let body = serde_json::json!({
        "session_id": session_id,
        "requested_at": now_millis(),
    });
    let _ = std::fs::write(dir.join("focus-request.json"), body.to_string());
}

/// True if process `pid` currently exists. `kill(pid, 0)` delivers no signal — it
/// only probes: 0 = alive, EPERM = alive but owned by another user, ESRCH = gone.
#[cfg(target_os = "macos")]
fn pid_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Workspace folders of every **live** IDE window, from the lock files each IDE
/// window writes (~/.claude/ide/*.lock — `workspaceFolders` + owning `pid`). A lock
/// whose pid is dead is skipped, so a force-quit/crashed IDE that left its lock behind
/// stops keeping its sessions lit (decision 027). Returns empty when the ide dir is
/// missing/unreadable — callers read that as "no liveness signal" and fall back to the
/// idle timeout, so we never prune every light off one bad read or a no-IDE machine.
#[cfg(target_os = "macos")]
fn live_workspace_folders() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let ide_dir = std::path::PathBuf::from(home).join(".claude").join("ide");
    let mut folders = Vec::new();
    let Ok(entries) = std::fs::read_dir(&ide_dir) else {
        return folders;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("lock") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if let Some(pid) = v.get("pid").and_then(|x| x.as_i64()) {
            if !pid_alive(pid) {
                continue;
            }
        }
        if let Some(arr) = v.get("workspaceFolders").and_then(|x| x.as_array()) {
            for f in arr.iter().filter_map(|x| x.as_str()) {
                folders.push(f.to_string());
            }
        }
    }
    folders
}

/// Non-macOS builds have no IDE-lock liveness signal; the idle timeout alone prunes.
#[cfg(not(target_os = "macos"))]
fn live_workspace_folders() -> Vec<String> {
    Vec::new()
}

/// True if `cwd` sits inside one of the live IDE workspace folders — an exact match,
/// or a subfolder a session `cd`'d into (same prefix rule as `workspace_root`). An
/// empty cwd matches nothing: it's an anonymous session no live window claims.
fn cwd_is_live(cwd: &str, folders: &[String]) -> bool {
    if cwd.is_empty() {
        return false;
    }
    folders
        .iter()
        .any(|f| cwd == f || cwd.starts_with(&format!("{f}/")))
}

/// agent_type of each currently-running subagent, read from the per-session
/// marker directory sessions/<id>.subagents/ (one file per subagent — race-free
/// under parallel subagents; decision 010).
fn read_subagents(dir: &std::path::Path, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir.join(format!("{id}.subagents"))) {
        for e in entries.flatten() {
            let t = std::fs::read_to_string(e.path()).unwrap_or_default();
            let t = t.trim();
            out.push(if t.is_empty() { "agent".to_string() } else { t.to_string() });
        }
    }
    out
}

#[tauri::command]
fn list_sessions() -> Vec<SessionStatus> {
    let mut out = Vec::new();
    let now = now_unix();
    let dir = sessions_dir();
    // Workspace folders of the currently-open IDE windows. A session whose folder
    // isn't among them has had its window closed (or never had one — an anonymous
    // ghost), so its light is stale (decision 027). Empty ⇒ no liveness signal, so
    // lock-pruning is skipped below and only the idle timeout applies.
    let live_folders = live_workspace_folders();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let updated_at = v.get("updated_at").and_then(|x| x.as_i64()).unwrap_or(0);
        let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("");
        // Prune dead sessions (delete the file + subagent markers, skip it; self-heals
        // on the session's next event) two ways:
        //   (a) window gone — the session's workspace maps to no live IDE lock, so its
        //       window was closed / the IDE quit. Instant, no waiting on the timer
        //       (decision 027). Skipped when no live lock exists at all so one bad read
        //       (or a no-IDE machine) never nukes every light.
        //   (b) unclean death with the window still open, or a superseded session
        //       sharing a live window's lock: silent past MAX_IDLE_SECS (decision 004).
        let ide = v.get("ide").and_then(|x| x.as_str()).unwrap_or("vscode");
        let uses_ide_locks = ide == "vscode" || ide == "cursor";
        let window_gone = uses_ide_locks && !live_folders.is_empty() && !cwd_is_live(cwd, &live_folders);
        if window_gone || now - updated_at > MAX_IDLE_SECS {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir_all(dir.join(format!("{id}.subagents")));
            continue;
        }
        let subagents = read_subagents(&dir, &id);
        out.push(SessionStatus {
            id,
            state: v.get("state").and_then(|x| x.as_str()).unwrap_or("idle").to_string(),
            cwd: cwd.to_string(),
            label: v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            updated_at,
            task: v.get("task").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            detail: v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            ide: ide.to_string(),
            subagents,
        });
    }
    // Stable order: by folder label, then id, so lights don't reshuffle each poll.
    out.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Convert the window into a non-activating NSPanel so it can float over other
/// apps' full-screen spaces without stealing focus or switching Spaces — the only
/// window type macOS lets sit over a third-party full-screen window.
#[cfg(target_os = "macos")]
fn make_overlay_panel(win: &tauri::WebviewWindow) {
    use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
    use tauri_nspanel::WebviewWindowExt;

    let Ok(panel) = win.to_panel() else { return };

    // Above normal app windows.
    panel.set_level(4); // NSFloatingWindowLevel

    // Non-activating: showing the panel never becomes key, so it never yanks you
    // out of a full-screen app.
    #[allow(non_upper_case_globals)]
    const NS_NONACTIVATING_PANEL: i32 = 1 << 7;
    panel.set_style_mask(NS_NONACTIVATING_PANEL);

    // Appear on every Space, including over full-screen apps.
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces,
    );

    panel.show();
}

/// Resolve the IDE workspace root that contains `cwd` from the IDE lock files
/// (~/.claude/ide/*.lock), each of which lists its window's `workspaceFolders`. A
/// session that `cd`'d into a subfolder still maps back to the window that has the
/// *root* open (the raw subfolder path would otherwise open as its own new window).
/// Returns the longest matching workspace folder, or `cwd` unchanged if none match.
#[cfg(target_os = "macos")]
fn workspace_root(cwd: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let ide_dir = std::path::PathBuf::from(home).join(".claude").join("ide");
    let mut best = String::new();
    if let Ok(entries) = std::fs::read_dir(&ide_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("lock") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let Some(folders) = v.get("workspaceFolders").and_then(|x| x.as_array()) else {
                continue;
            };
            for folder in folders {
                let Some(f) = folder.as_str() else { continue };
                let matches = cwd == f || cwd.starts_with(&format!("{f}/"));
                if matches && f.len() > best.len() {
                    best = f.to_string();
                }
            }
        }
    }
    if best.is_empty() { cwd.to_string() } else { best }
}

/// Fast same-Space window raise (decision 021). The IDE CLI below is the correct,
/// cross-Space raise, but it boots a Node runtime on every click (~1.1s measured).
/// When the target window is on the *current* Space this osascript raise brings it
/// forward in ~0.2s. It goes through System Events (`set frontmost` + AXRaise), which
/// needs one permission — Accessibility — and no per-app Automation prompt. It can't
/// see full-screen windows on inactive Spaces, so it is strictly best-effort: we
/// always *also* fire the CLI, which handles the cross-Space / full-screen case.
/// Without an Accessibility grant this silently no-ops and the CLI alone runs (no
/// regression vs. the old behavior). The window is matched by the workspace-root
/// basename — the project folder, which appears in the IDE window title.
#[cfg(target_os = "macos")]
fn raise_window_fast(root: &str, ide: &str) {
    let name = std::path::Path::new(root)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if name.is_empty() {
        return;
    }
    let proc = if ide == "cursor" {
        "Cursor"
    } else if ide == "codex" {
        "Codex"
    } else {
        "Code"
    };
    // Escape for an AppleScript double-quoted string literal.
    let esc = name.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "tell application \"System Events\" to tell process \"{proc}\"\n\
           set frontmost to true\n\
           set ws to (windows whose title contains \"{esc}\")\n\
           if (count of ws) > 0 then perform action \"AXRaise\" of item 1 of ws\n\
         end tell"
    );
    let _ = std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn();
}

/// Jump to a session's window by focusing it through the **IDE's own CLI**
/// (`code`/`cursor <folder>`). The IDE resolves the folder to its existing window
/// and focuses it — switching macOS Spaces (including a full-screen Space) because
/// the app manages its own window. It only opens a new window if the folder isn't
/// open anywhere. We focus the *workspace root* (from the lock files) so a subfolder
/// `cwd` still lands on the right window.
///
/// This replaces the old `open -a <folder>` (decision 016): `open -a` spawns a *new*
/// window whenever macOS can't match an existing one — which is exactly what happens
/// with full-screen windows in their own Spaces (the app's core use case), since
/// they aren't reachable from another Space. The IDE CLI has no such limitation and
/// needs no extra permission (unlike AppleScript window-raising, which can't even see
/// full-screen windows on inactive Spaces — verified live). If the CLI binary is
/// missing we fall back to `open -a` (Agent Guideline #3: degrade, never break). The
/// IDE is chosen from the session's `ide` field (decision 015).
#[tauri::command]
fn focus_session(cwd: String, ide: String, session_id: String) {
    // Focus the exact session tab via the extension relay (decision 015); the window
    // raise below only gets us to the right *window*. Written first so the extension
    // can pick it up while / right after the window comes forward.
    write_focus_request(&session_id);
    #[cfg(target_os = "macos")]
    {
        if ide == "codex" {
            let _ = std::process::Command::new("open").args(["-a", "Codex"]).spawn();
            return;
        }
        if cwd.is_empty() {
            return;
        }
        let root = workspace_root(&cwd);
        // Fast path first: raise the window in ~0.2s if it's on the current Space.
        // The CLI below always runs too, covering the cross-Space / full-screen case
        // the fast path can't reach (decision 021).
        raise_window_fast(&root, &ide);
        let (cli, app) = if ide == "cursor" {
            (
                "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
                "Cursor",
            )
        } else {
            (
                "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
                "Visual Studio Code",
            )
        };
        if std::path::Path::new(cli).exists() {
            let _ = std::process::Command::new(cli).arg(&root).spawn();
        } else {
            let _ = std::process::Command::new("open")
                .args(["-a", app])
                .arg(&root)
                .spawn();
        }
    }
}

/// Quit the whole app from the settings panel. As an Accessory app (no Dock icon,
/// no app menu — see `setup`) the bar has no OS-provided Quit, so this button is the
/// only in-UI way out. `exit(0)` tears down the panel and tray and ends the process;
/// the hooks keep writing status files regardless, so relaunching repopulates the bar.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Switch the bar between its two presentations (decision 024). Floating = the
/// always-visible NSPanel (default); menu-bar = a tray item that shows the lights as
/// a generated image (`set_tray_image`) and reveals the panel as a popover on click.
/// The frontend owns the persisted preference (`localStorage`) and calls this on load
/// and on toggle; here we only flip the tray's visibility and hide/show the panel.
#[tauri::command]
fn set_mode(app: tauri::AppHandle, mode: String) {
    #[cfg(target_os = "macos")]
    {
        let menubar = mode == "menubar";
        let app2 = app.clone();
        // NSStatusItem must be manipulated on the main thread; Tauri commands run on a
        // background thread, so marshal there. Window show/hide is marshaled by Tauri
        // internally, but we do it here too so it stays ordered with the tray change.
        let _ = app.run_on_main_thread(move || {
            let has_tray = match app2.tray_by_id(TRAY_ID) {
                Some(tray) => {
                    let _ = tray.set_visible(menubar);
                    true
                }
                None => false,
            };
            if let Some(win) = app2.get_webview_window("main") {
                // Hide the panel only when there's actually a tray to represent it —
                // otherwise keep it visible so a tray failure never strands the user
                // with no UI at all.
                if menubar && has_tray {
                    let _ = win.hide();
                } else {
                    let _ = win.show();
                }
            }
        });
    }
}

/// Paint the tray icon from RGBA pixels the webview rendered (the row of colored dots,
/// or a single summary dot when condensed). Reusing the webview's canvas keeps one
/// source of truth for the per-state colors (decision 017) instead of redrawing them
/// in Rust. Called only in menu-bar mode, and only when the image actually changed
/// (the frontend signature-skips unchanged frames), so this is cheap at the 1 Hz poll.
#[tauri::command]
fn set_tray_image(app: tauri::AppHandle, rgba: Vec<u8>, width: u32, height: u32) {
    #[cfg(target_os = "macos")]
    {
        if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
            return;
        }
        let app2 = app.clone();
        // set_icon touches the NSStatusItem → main thread only (see set_mode).
        let _ = app.run_on_main_thread(move || {
            if let Some(tray) = app2.tray_by_id(TRAY_ID) {
                let img = tauri::image::Image::new_owned(rgba, width, height);
                let _ = tray.set_icon(Some(img));
                // Force color rendering: a template icon is drawn as a monochrome
                // alpha mask (all opaque pixels → black/white), which swallows our
                // per-state colors. The builder flag doesn't survive set_icon, so
                // re-assert it on every image.
                let _ = tray.set_icon_as_template(false);
            }
        });
    }
}

/// Toggle the panel as a popover anchored under the tray icon. A left-click on the
/// tray item shows the panel centered below the click point (just under the menu bar);
/// a second click hides it. The panel keeps its NSPanel properties across hide/show, so
/// per-light click, hover, and badges work exactly as in floating mode. `cx`/`cy` are
/// the click's physical screen coordinates (the cursor sits in the menu bar on click).
#[cfg(target_os = "macos")]
fn toggle_popover(win: &tauri::WebviewWindow, cx: f64, cy: f64) {
    if matches!(win.is_visible(), Ok(true)) {
        let _ = win.hide();
        return;
    }
    let win_w = win.outer_size().map(|s| s.width as f64).unwrap_or(0.0);
    let x = (cx - win_w / 2.0).max(0.0);
    let y = cy + 8.0; // just below the menu bar the cursor is in
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance guard (release only). A second launch of the app — the
    // installed /Applications copy or a dev build, both sharing the identifier
    // com.claudestatus.app — pings the already-running instance and exits, instead
    // of drawing a second overlapping bar off the same status dir. Must be the first
    // plugin registered. Gated off in dev so `npm run tauri dev` still runs while the
    // installed copy is up.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // The one legitimate copy stays; the newcomer already exited. Make sure
            // the survivor's bar is visible in case it was hidden.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            focus_session,
            set_mode,
            set_tray_image,
            quit_app
        ])
        .setup(|app| {
            // Accessory (agent) app: no Dock icon, not space-managed.
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // Menu-bar tray item (decision 024). Built once here (on the main thread)
            // but hidden until the frontend switches to menu-bar mode via `set_mode`.
            // Colored (not template) so the status dots show in color; left-click is
            // handled by us (popover), not a menu. Placeholder icon until the webview
            // pushes the first dot image.
            #[cfg(target_os = "macos")]
            {
                let mut tb = TrayIconBuilder::with_id(TRAY_ID)
                    .icon_as_template(false)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            position,
                            ..
                        } = event
                        {
                            if let Some(win) = tray.app_handle().get_webview_window("main") {
                                toggle_popover(&win, position.x, position.y);
                            }
                        }
                    });
                if let Some(icon) = app.default_window_icon().cloned() {
                    tb = tb.icon(icon);
                }
                match tb.build(app) {
                    Ok(tray) => {
                        let _ = tray.set_visible(false);
                    }
                    Err(e) => eprintln!("[claudestatus] tray build failed: {e}"),
                }
            }
            // Packaged app self-installs its hooks. In dev we keep the repo hooks
            // (via `node hooks/setup.mjs`) so hook edits are live without a rebuild.
            #[cfg(not(debug_assertions))]
            install::ensure_installed();
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                make_overlay_panel(&win);
                let _ = win.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

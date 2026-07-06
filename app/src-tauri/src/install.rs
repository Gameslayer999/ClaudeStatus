// ClaudeStatus — self-installer (packaged app).
//
// On launch the bundled app makes itself work with zero external steps: it writes
// an embedded copy of the status hook to a stable location and registers it in the
// user's ~/.claude/settings.json. Idempotent (safe every launch), reversible (a
// one-time backup), and non-clobbering (only touches its own hook entries).
//
// The hook script is embedded at compile time, so the .app is self-contained and
// the installed hook always matches the shipped app version. Gated to release
// builds — in dev we keep pointing at the repo's hooks/ via `node hooks/setup.mjs`.

use std::path::PathBuf;

const REPORT_SH: &str = include_str!("../../../hooks/report.sh");

// Same event set as hooks/setup.mjs. Tool events take a "*" matcher.
const SIMPLE_EVENTS: &[&str] = &[
    "SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "StopFailure",
    "SubagentStart", "SubagentStop",
];
const TOOL_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn claude_dir() -> PathBuf {
    home().join(".claude")
}

fn status_dir() -> PathBuf {
    match std::env::var("CLAUDESTATUS_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => claude_dir().join("status"),
    }
}

/// Best-effort: never panics, never blocks the app if it fails.
pub fn ensure_installed() {
    if let Err(e) = try_install() {
        eprintln!("ClaudeStatus: self-install skipped: {e}");
    }
}

fn try_install() -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    // 1. Write the hook script to a stable, app-independent location.
    let status = status_dir();
    std::fs::create_dir_all(status.join("sessions"))?;
    let script = status.join("report.sh");
    std::fs::write(&script, REPORT_SH)?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
    let script_str = script.to_string_lossy().to_string();

    // 2. Merge our hooks into ~/.claude/settings.json.
    let settings_path = claude_dir().join("settings.json");
    let mut settings = if settings_path.exists() {
        let txt = std::fs::read_to_string(&settings_path)?;
        let bak = claude_dir().join("settings.json.claudestatus-bak");
        if !bak.exists() {
            let _ = std::fs::write(&bak, &txt);
        }
        serde_json::from_str::<serde_json::Value>(&txt).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        std::fs::create_dir_all(claude_dir())?;
        serde_json::json!({})
    };

    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let obj = settings.as_object_mut().unwrap();
    let hooks_val = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks_val.is_object() {
        *hooks_val = serde_json::json!({});
    }
    let hooks = hooks_val.as_object_mut().unwrap();

    let events = SIMPLE_EVENTS
        .iter()
        .map(|e| (*e, false))
        .chain(TOOL_EVENTS.iter().map(|e| (*e, true)));
    for (event, with_matcher) in events {
        let list = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .unwrap();
        // Drop any prior ClaudeStatus entries so re-running never duplicates.
        list.retain(|entry| !entry.to_string().contains("report.sh"));
        let hook = serde_json::json!({ "type": "command", "command": format!("{script_str} {event}") });
        let registered = if with_matcher {
            serde_json::json!({ "matcher": "*", "hooks": [hook] })
        } else {
            serde_json::json!({ "hooks": [hook] })
        };
        list.push(registered);
    }

    std::fs::write(&settings_path, serde_json::to_string_pretty(&settings)? + "\n")?;
    Ok(())
}

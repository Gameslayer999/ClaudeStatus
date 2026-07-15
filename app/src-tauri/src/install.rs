// AgentStatus — self-installer (packaged app).
//
// On launch the bundled app makes itself work with zero external steps: it writes
// an embedded copy of the status hook to a stable location and registers it in the
// user's Claude and Codex hook configs. Idempotent (safe every launch),
// reversible (a one-time backup), and non-clobbering (only touches its own hook
// entries).
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
const CODEX_SIMPLE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];
const CODEX_TOOL_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "PermissionRequest"];

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn claude_dir() -> PathBuf {
    home().join(".claude")
}

fn codex_dir() -> PathBuf {
    home().join(".codex")
}

fn status_dir() -> PathBuf {
    match std::env::var("AGENTSTATUS_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => match std::env::var("CLAUDESTATUS_DIR") {
            Ok(d) if !d.is_empty() => PathBuf::from(d),
            _ => claude_dir().join("status"),
        },
    }
}

/// Best-effort: never panics, never blocks the app if it fails.
pub fn ensure_installed() {
    if let Err(e) = try_install() {
        eprintln!("AgentStatus: self-install skipped: {e}");
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

    // 2. Merge our hooks into Claude and Codex user-level hook config.
    merge_hooks(
        claude_dir().join("settings.json"),
        claude_dir().join("settings.json.agentstatus-bak"),
        &script_str,
        SIMPLE_EVENTS,
        TOOL_EVENTS,
        "",
    )?;
    // "codex" arg: report.sh can't sniff Codex from its Claude-shaped payloads,
    // so the installer declares the host explicitly (decision 032).
    merge_hooks(
        codex_dir().join("hooks.json"),
        codex_dir().join("hooks.json.agentstatus-bak"),
        &script_str,
        CODEX_SIMPLE_EVENTS,
        CODEX_TOOL_EVENTS,
        "codex",
    )?;

    merge_antigravity_hooks(
        home().join(".gemini").join("config").join("hooks.json"),
        home().join(".gemini").join("config").join("hooks.json.agentstatus-bak"),
        &script_str,
    )?;

    Ok(())
}

fn merge_antigravity_hooks(
    hooks_path: PathBuf,
    backup_path: PathBuf,
    script_str: &str,
) -> std::io::Result<()> {
    if let Some(parent) = hooks_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut hooks_config = if hooks_path.exists() {
        let txt = std::fs::read_to_string(&hooks_path)?;
        if !backup_path.exists() {
            let _ = std::fs::write(&backup_path, &txt);
        }
        serde_json::from_str::<serde_json::Value>(&txt).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !hooks_config.is_object() {
        hooks_config = serde_json::json!({});
    }
    let obj = hooks_config.as_object_mut().unwrap();
    let agentstatus = obj.entry("agentstatus").or_insert_with(|| serde_json::json!({}));
    if !agentstatus.is_object() {
        *agentstatus = serde_json::json!({});
    }
    let entry = agentstatus.as_object_mut().unwrap();
    entry.insert("enabled".to_string(), serde_json::json!(true));

    // PreInvocation
    entry.insert(
        "PreInvocation".to_string(),
        serde_json::json!([
            { "type": "command", "command": format!("{script_str} PreInvocation antigravity") }
        ]),
    );

    // PreToolUse
    entry.insert(
        "PreToolUse".to_string(),
        serde_json::json!([
            {
                "matcher": ".*",
                "hooks": [
                    { "type": "command", "command": format!("{script_str} PreToolUse antigravity") }
                ]
            }
        ]),
    );

    // PostToolUse
    entry.insert(
        "PostToolUse".to_string(),
        serde_json::json!([
            {
                "matcher": ".*",
                "hooks": [
                    { "type": "command", "command": format!("{script_str} PostToolUse antigravity") }
                ]
            }
        ]),
    );

    // Stop
    entry.insert(
        "Stop".to_string(),
        serde_json::json!([
            { "type": "command", "command": format!("{script_str} Stop antigravity") }
        ]),
    );

    std::fs::write(&hooks_path, serde_json::to_string_pretty(&hooks_config)? + "\n")?;
    Ok(())
}

fn merge_hooks(
    settings_path: PathBuf,
    backup_path: PathBuf,
    script_str: &str,
    simple_events: &[&str],
    tool_events: &[&str],
    ide_arg: &str,
) -> std::io::Result<()> {
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut settings = if settings_path.exists() {
        let txt = std::fs::read_to_string(&settings_path)?;
        if !backup_path.exists() {
            let _ = std::fs::write(&backup_path, &txt);
        }
        serde_json::from_str::<serde_json::Value>(&txt).unwrap_or_else(|_| serde_json::json!({}))
    } else {
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

    let events = simple_events
        .iter()
        .map(|e| (*e, false))
        .chain(tool_events.iter().map(|e| (*e, true)));
    for (event, with_matcher) in events {
        let list = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .unwrap();
        // Drop any prior AgentStatus entries so re-running never duplicates.
        list.retain(|entry| !entry.to_string().contains("report.sh"));
        let command = if ide_arg.is_empty() {
            format!("{script_str} {event}")
        } else {
            format!("{script_str} {event} {ide_arg}")
        };
        let hook = serde_json::json!({ "type": "command", "command": command });
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

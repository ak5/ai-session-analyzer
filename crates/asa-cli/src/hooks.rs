use anyhow::{Context, Result, bail};
use asa_adapters::AdapterName;
use directories::BaseDirs;
use serde_json::{Map, Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "SessionEnd",
];
const CLAUDE_ONLY_EVENTS: &[&str] = &["PostToolUseFailure"];

#[derive(Clone, Copy, Debug)]
pub enum HookScope {
    Project,
    User,
}

impl std::str::FromStr for HookScope {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "project" => Ok(Self::Project),
            "user" => Ok(Self::User),
            _ => bail!("scope must be project or user"),
        }
    }
}

pub struct HookLocation {
    pub adapter: AdapterName,
    pub path: PathBuf,
}

pub fn locations(
    adapters: &[AdapterName],
    scope: HookScope,
    cwd: &Path,
) -> Result<Vec<HookLocation>> {
    let base = match scope {
        HookScope::Project => cwd.to_path_buf(),
        HookScope::User => BaseDirs::new()
            .context("platform does not provide a user home directory")?
            .home_dir()
            .to_path_buf(),
    };
    Ok(adapters
        .iter()
        .map(|adapter| HookLocation {
            adapter: *adapter,
            path: match (scope, adapter) {
                (HookScope::Project, AdapterName::ClaudeCode) => {
                    base.join(".claude/settings.local.json")
                }
                (HookScope::User, AdapterName::ClaudeCode) => base.join(".claude/settings.json"),
                (HookScope::Project | HookScope::User, AdapterName::Codex) => {
                    base.join(".codex/hooks.json")
                }
            },
        })
        .collect())
}

pub fn install(location: &HookLocation, executable: &Path) -> Result<bool> {
    let mut root = read_object_or_empty(&location.path)?;
    let hooks = object_field_mut(&mut root, "hooks")?;
    let command = hook_command(executable, location.adapter);
    let mut changed = false;
    for event in events(location.adapter) {
        let groups = array_field_mut(hooks, event)?;
        if contains_asa_handler(groups, location.adapter) {
            continue;
        }
        groups.push(json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 1
            }]
        }));
        changed = true;
    }
    if changed {
        write_json_atomic(&location.path, &Value::Object(root))?;
    }
    Ok(changed)
}

pub fn uninstall(location: &HookLocation) -> Result<bool> {
    if !location.path.exists() {
        return Ok(false);
    }
    let mut root = read_object_or_empty(&location.path)?;
    let original_root = root.clone();
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let events = hooks.keys().cloned().collect::<Vec<_>>();
    for event in events {
        let Some(groups) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
            continue;
        };
        for group in groups.iter_mut() {
            remove_asa_handlers(group, location.adapter);
        }
        groups.retain(group_has_handlers);
        if groups.is_empty() {
            hooks.remove(&event);
        }
    }
    let changed = root != original_root;
    if changed {
        write_json_atomic(&location.path, &Value::Object(root))?;
    }
    Ok(changed)
}

pub fn installed(location: &HookLocation) -> Result<bool> {
    if !location.path.exists() {
        return Ok(false);
    }
    let root = read_object_or_empty(&location.path)?;
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        return Ok(false);
    };
    Ok(events(location.adapter).into_iter().all(|event| {
        hooks
            .get(event)
            .and_then(Value::as_array)
            .is_some_and(|groups| contains_asa_handler(groups, location.adapter))
    }))
}

pub fn doctor(location: &HookLocation, executable: &Path) -> Result<Vec<String>> {
    let mut findings = Vec::new();
    if !executable.is_absolute() {
        findings.push("ASA executable path is not absolute".to_owned());
    }
    if !executable.is_file() {
        findings.push(format!(
            "ASA executable does not exist: {}",
            executable.display()
        ));
    }
    if !location.path.exists() {
        findings.push(format!("hook file is missing: {}", location.path.display()));
        return Ok(findings);
    }
    let root = read_object_or_empty(&location.path)?;
    let Some(hooks) = root.get("hooks").and_then(Value::as_object) else {
        findings.push("hook file has no hooks object".to_owned());
        return Ok(findings);
    };
    for event in events(location.adapter) {
        if !hooks
            .get(event)
            .and_then(Value::as_array)
            .is_some_and(|groups| contains_asa_handler(groups, location.adapter))
        {
            findings.push(format!("{event} ASA handler is missing"));
        }
    }
    Ok(findings)
}

fn events(adapter: AdapterName) -> Vec<&'static str> {
    let mut events = EVENTS.to_vec();
    if adapter == AdapterName::ClaudeCode {
        events.extend_from_slice(CLAUDE_ONLY_EVENTS);
    }
    events
}

fn read_object_or_empty(path: &Path) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice::<Value>(&bytes)
        .with_context(|| format!("parse {}", path.display()))?
        .as_object()
        .cloned()
        .with_context(|| format!("{} must contain a JSON object", path.display()))
}

fn object_field_mut<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>> {
    let value = root
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .with_context(|| format!("{key} must be an object"))
}

fn array_field_mut<'a>(root: &'a mut Map<String, Value>, key: &str) -> Result<&'a mut Vec<Value>> {
    let value = root
        .entry(key.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    value
        .as_array_mut()
        .with_context(|| format!("hooks.{key} must be an array"))
}

fn contains_asa_handler(groups: &[Value], adapter: AdapterName) -> bool {
    groups.iter().any(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|handlers| {
                handlers
                    .iter()
                    .any(|handler| is_asa_handler(handler, adapter))
            })
    })
}

fn is_asa_handler(handler: &Value, adapter: AdapterName) -> bool {
    handler
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            command.contains(" hook ingest ")
                && command.contains(&format!("--adapter {}", adapter.as_str()))
        })
}

fn remove_asa_handlers(group: &mut Value, adapter: AdapterName) {
    if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
        handlers.retain(|handler| !is_asa_handler(handler, adapter));
    }
}

fn group_has_handlers(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|handlers| !handlers.is_empty())
}

fn hook_command(executable: &Path, adapter: AdapterName) -> String {
    format!(
        "{} hook ingest --adapter {}",
        shell_quote(&executable.to_string_lossy()),
        adapter.as_str()
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("asa.tmp");
    let mut file = fs::File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    fs::rename(&temporary, path)?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn location(root: &Path, adapter: AdapterName) -> HookLocation {
        HookLocation {
            adapter,
            path: root.join("hooks.json"),
        }
    }

    #[test]
    fn install_preserves_unrelated_hooks_and_is_idempotent() {
        let temp = TempDir::new().unwrap();
        let location = location(temp.path(), AdapterName::Codex);
        fs::write(
            &location.path,
            r#"{"custom":true,"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other"}]}]}}"#,
        )
        .unwrap();
        assert!(install(&location, Path::new("/opt/asa")).unwrap());
        assert!(!install(&location, Path::new("/opt/asa")).unwrap());
        let value: Value = serde_json::from_slice(&fs::read(&location.path).unwrap()).unwrap();
        assert_eq!(value["custom"], true);
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn uninstall_removes_only_asa_handlers() {
        let temp = TempDir::new().unwrap();
        let location = location(temp.path(), AdapterName::ClaudeCode);
        install(&location, Path::new("/opt/asa")).unwrap();
        let mut value: Value = serde_json::from_slice(&fs::read(&location.path).unwrap()).unwrap();
        value["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(json!({"hooks":[{"type":"command","command":"other"}]}));
        write_json_atomic(&location.path, &value).unwrap();
        assert!(uninstall(&location).unwrap());
        let value: Value = serde_json::from_slice(&fs::read(&location.path).unwrap()).unwrap();
        assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(value["hooks"]["Stop"][0]["hooks"][0]["command"], "other");
    }
}

use crate::AdapterError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

const PATH_FIELDS: [&str; 4] = ["cwd", "workspace", "workspace_path", "project_path"];

#[derive(Clone, Debug)]
pub struct MigrationConfig {
    pub claude_config: PathBuf,
    pub codex_home: PathBuf,
    pub journal_root: PathBuf,
}

impl MigrationConfig {
    pub fn discover(journal_root: &Path) -> Result<Self, AdapterError> {
        let home = directories::BaseDirs::new()
            .ok_or(AdapterError::NoHomeDirectory)?
            .home_dir()
            .to_path_buf();
        Ok(Self {
            claude_config: std::env::var_os("CLAUDE_CONFIG_DIR")
                .map_or_else(|| home.join(".claude"), PathBuf::from),
            codex_home: std::env::var_os("CODEX_HOME")
                .map_or_else(|| home.join(".codex"), PathBuf::from),
            journal_root: journal_root.to_path_buf(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MigrationOperation {
    pub adapter: String,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub session_id: Option<String>,
    pub remove_source: bool,
    pub records_changed: usize,
    contents: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MigrationPlan {
    pub id: String,
    pub old_path: PathBuf,
    pub new_path: PathBuf,
    pub operations: Vec<MigrationOperation>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MigrationReport {
    pub id: String,
    pub dry_run: bool,
    pub operations: usize,
    pub sessions: usize,
    pub records_changed: usize,
    pub journal: PathBuf,
    pub backup_root: PathBuf,
    pub planned: Vec<MigrationOperationSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MigrationOperationSummary {
    pub adapter: String,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub session_id: Option<String>,
    pub remove_source: bool,
    pub records_changed: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Journal {
    plan: MigrationPlan,
    completed: Vec<bool>,
    finished: bool,
}

pub fn plan_workspace_path_migration(
    old: &Path,
    new: &Path,
    config: &MigrationConfig,
) -> Result<MigrationPlan, AdapterError> {
    let old = lexical_absolute(old)?;
    let new = lexical_absolute(new)?;
    if old == new {
        return Err(AdapterError::Migration(
            "old and new workspace paths are identical".to_owned(),
        ));
    }
    let mut operations = Vec::new();
    plan_claude(&old, &new, config, &mut operations)?;
    plan_codex(&old, &new, config, &mut operations)?;
    operations.sort_by(|a, b| {
        (&a.adapter, &a.source, &a.destination).cmp(&(&b.adapter, &b.source, &b.destination))
    });
    validate_collisions(&operations)?;
    let id = migration_id(&old, &new, config);
    Ok(MigrationPlan {
        id,
        old_path: old,
        new_path: new,
        operations,
    })
}

pub fn migrate_workspace_path(
    old: &Path,
    new: &Path,
    config: &MigrationConfig,
    dry_run: bool,
) -> Result<MigrationReport, AdapterError> {
    let old = lexical_absolute(old)?;
    let new = lexical_absolute(new)?;
    let id = migration_id(&old, &new, config);
    let journal_path = config
        .journal_root
        .join("migration-journals")
        .join(format!("{id}.json"));
    let backup_root = config.journal_root.join("migration-backups").join(&id);
    let saved = (!dry_run && journal_path.exists())
        .then(|| fs::read(&journal_path))
        .transpose()?
        .map(|bytes| serde_json::from_slice::<Journal>(&bytes))
        .transpose()?;
    let plan = if let Some(journal) = &saved {
        journal.plan.clone()
    } else {
        plan_workspace_path_migration(&old, &new, config)?
    };
    let sessions = plan
        .operations
        .iter()
        .filter_map(|operation| {
            operation
                .session_id
                .as_ref()
                .map(|id| (&operation.adapter, id))
        })
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let records_changed = plan
        .operations
        .iter()
        .map(|operation| operation.records_changed)
        .sum();
    if dry_run {
        return Ok(MigrationReport {
            id: plan.id.clone(),
            dry_run: true,
            operations: plan.operations.len(),
            sessions,
            records_changed,
            journal: journal_path,
            backup_root,
            planned: summarize(&plan),
        });
    }
    fs::create_dir_all(
        journal_path
            .parent()
            .ok_or_else(|| AdapterError::InvalidSessionPath(journal_path.clone()))?,
    )?;
    fs::create_dir_all(&backup_root)?;
    let mut journal = if let Some(saved) = saved {
        if saved.plan.old_path != plan.old_path || saved.plan.new_path != plan.new_path {
            return Err(AdapterError::Migration(format!(
                "journal {} belongs to a different migration",
                journal_path.display()
            )));
        }
        saved
    } else {
        Journal {
            completed: vec![false; plan.operations.len()],
            plan,
            finished: false,
        }
    };
    write_json_atomic(&journal_path, &journal)?;
    for index in 0..journal.plan.operations.len() {
        if journal.completed[index] {
            continue;
        }
        apply_operation(&journal.plan.operations[index], &backup_root, index)?;
        journal.completed[index] = true;
        write_json_atomic(&journal_path, &journal)?;
    }
    journal.finished = true;
    write_json_atomic(&journal_path, &journal)?;
    Ok(MigrationReport {
        id: journal.plan.id.clone(),
        dry_run: false,
        operations: journal.plan.operations.len(),
        sessions,
        records_changed,
        journal: journal_path,
        backup_root,
        planned: summarize(&journal.plan),
    })
}

fn summarize(plan: &MigrationPlan) -> Vec<MigrationOperationSummary> {
    plan.operations
        .iter()
        .map(|operation| MigrationOperationSummary {
            adapter: operation.adapter.clone(),
            source: operation.source.clone(),
            destination: operation.destination.clone(),
            session_id: operation.session_id.clone(),
            remove_source: operation.remove_source,
            records_changed: operation.records_changed,
        })
        .collect()
}

fn migration_id(old: &Path, new: &Path, config: &MigrationConfig) -> String {
    let mut digest = Sha256::new();
    digest.update(old.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(new.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(config.claude_config.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(config.codex_home.as_os_str().as_encoded_bytes());
    hex::encode(digest.finalize())[..20].to_owned()
}

fn plan_claude(
    old: &Path,
    new: &Path,
    config: &MigrationConfig,
    operations: &mut Vec<MigrationOperation>,
) -> Result<(), AdapterError> {
    let projects = config.claude_config.join("projects");
    for path in files_below(&projects)? {
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(session_id) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| uuid::Uuid::parse_str(value).is_ok())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let Some(project_dir) = path.parent() else {
            continue;
        };
        if project_dir.parent() != Some(projects.as_path()) {
            continue;
        }
        let Some((contents, changed, cwd)) = rewrite_jsonl(&path, old, new)? else {
            continue;
        };
        let destination_project = projects.join(claude_slug(&cwd));
        let destination = destination_project.join(
            path.file_name()
                .ok_or_else(|| AdapterError::InvalidSessionPath(path.clone()))?,
        );
        operations.push(MigrationOperation {
            adapter: "claude-code".to_owned(),
            remove_source: destination != path,
            source: path.clone(),
            destination,
            session_id: Some(session_id.clone()),
            records_changed: changed,
            contents,
        });
        let sidecar_root = project_dir.join(&session_id);
        for sidecar in files_below(&sidecar_root)? {
            let relative = sidecar
                .strip_prefix(&sidecar_root)
                .map_err(|_| AdapterError::InvalidSessionPath(sidecar.clone()))?;
            let (contents, records_changed) =
                if sidecar.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                    rewrite_jsonl(&sidecar, old, new)?
                        .map_or((fs::read(&sidecar)?, 0), |(contents, changed, _)| {
                            (contents, changed)
                        })
                } else {
                    (fs::read(&sidecar)?, 0)
                };
            let sidecar_destination = destination_project.join(&session_id).join(relative);
            operations.push(MigrationOperation {
                adapter: "claude-code".to_owned(),
                source: sidecar.clone(),
                remove_source: sidecar_destination != sidecar,
                destination: sidecar_destination,
                session_id: Some(session_id.clone()),
                records_changed,
                contents,
            });
        }
    }
    // Claude stores prompt history outside project directories.
    plan_index(
        "claude-code",
        &config.claude_config.join("history.jsonl"),
        old,
        new,
        operations,
    )?;
    Ok(())
}

fn plan_codex(
    old: &Path,
    new: &Path,
    config: &MigrationConfig,
    operations: &mut Vec<MigrationOperation>,
) -> Result<(), AdapterError> {
    for path in files_below(&config.codex_home.join("sessions"))? {
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some((contents, changed, _)) = rewrite_jsonl(&path, old, new)? else {
            continue;
        };
        operations.push(MigrationOperation {
            adapter: "codex".to_owned(),
            source: path.clone(),
            destination: path.clone(),
            session_id: path
                .file_name()
                .and_then(|value| value.to_str())
                .and_then(crate::rollout_session_id),
            remove_source: false,
            records_changed: changed,
            contents,
        });
    }
    plan_index(
        "codex",
        &config.codex_home.join("session_index.jsonl"),
        old,
        new,
        operations,
    )
}

fn plan_index(
    adapter: &str,
    path: &Path,
    old: &Path,
    new: &Path,
    operations: &mut Vec<MigrationOperation>,
) -> Result<(), AdapterError> {
    if let Some((contents, changed, _)) = rewrite_jsonl(path, old, new)? {
        operations.push(MigrationOperation {
            adapter: adapter.to_owned(),
            source: path.to_path_buf(),
            destination: path.to_path_buf(),
            session_id: None,
            remove_source: false,
            records_changed: changed,
            contents,
        });
    }
    Ok(())
}

fn rewrite_jsonl(
    path: &Path,
    old: &Path,
    new: &Path,
) -> Result<Option<(Vec<u8>, usize, PathBuf)>, AdapterError> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut output = Vec::with_capacity(bytes.len());
    let mut changed = 0;
    let mut representative = None;
    for line in text.lines() {
        let Ok(mut value) = serde_json::from_str::<Value>(line) else {
            output.extend_from_slice(line.as_bytes());
            output.push(b'\n');
            continue;
        };
        let count = rewrite_paths(&mut value, old, new, &mut representative);
        changed += count;
        if count == 0 {
            output.extend_from_slice(line.as_bytes());
        } else {
            serde_json::to_writer(&mut output, &value)?;
        }
        output.push(b'\n');
    }
    Ok((changed > 0).then(|| {
        (
            output,
            changed,
            representative.unwrap_or_else(|| new.to_path_buf()),
        )
    }))
}

fn rewrite_paths(
    value: &mut Value,
    old: &Path,
    new: &Path,
    representative: &mut Option<PathBuf>,
) -> usize {
    match value {
        Value::Object(object) => {
            let mut changed = 0;
            for (key, value) in object {
                if PATH_FIELDS.contains(&key.as_str())
                    && let Some(current) = value.as_str()
                    && let Some(rewritten) = replace_prefix(Path::new(current), old, new)
                {
                    *representative = Some(rewritten.clone());
                    *value = Value::String(rewritten.to_string_lossy().into_owned());
                    changed += 1;
                } else {
                    changed += rewrite_paths(value, old, new, representative);
                }
            }
            changed
        }
        Value::Array(values) => values
            .iter_mut()
            .map(|value| rewrite_paths(value, old, new, representative))
            .sum(),
        _ => 0,
    }
}

fn replace_prefix(path: &Path, old: &Path, new: &Path) -> Option<PathBuf> {
    let absolute = lexical_absolute(path).ok()?;
    absolute.strip_prefix(old).ok().map(|suffix| {
        if suffix.as_os_str().is_empty() {
            new.to_path_buf()
        } else {
            new.join(suffix)
        }
    })
}

fn lexical_absolute(path: &Path) -> Result<PathBuf, AdapterError> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}

fn claude_slug(path: &Path) -> String {
    path.to_string_lossy().replace('/', "-")
}

fn files_below(root: &Path) -> Result<Vec<PathBuf>, AdapterError> {
    let mut files = Vec::new();
    if !root.exists() {
        return Ok(files);
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            } else if entry.file_type()?.is_file() {
                files.push(entry.path());
            }
        }
    }
    Ok(files)
}

fn validate_collisions(operations: &[MigrationOperation]) -> Result<(), AdapterError> {
    let mut destinations = std::collections::BTreeSet::new();
    for operation in operations {
        if !destinations.insert(operation.destination.clone()) {
            return Err(AdapterError::Migration(format!(
                "multiple sources target {}",
                operation.destination.display()
            )));
        }
        if operation.destination != operation.source && operation.destination.exists() {
            return Err(AdapterError::Migration(format!(
                "destination already exists: {}",
                operation.destination.display()
            )));
        }
    }
    Ok(())
}

fn apply_operation(
    operation: &MigrationOperation,
    backup_root: &Path,
    index: usize,
) -> Result<(), AdapterError> {
    let backup = backup_root.join(format!("{index:06}.bak"));
    if !backup.exists() {
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent)?;
        }
        write_exclusive(&backup, &fs::read(&operation.source)?)?;
    }
    if operation.destination != operation.source && operation.destination.exists() {
        if fs::read(&operation.destination)? != operation.contents {
            return Err(AdapterError::Migration(format!(
                "destination changed while resuming: {}",
                operation.destination.display()
            )));
        }
    } else {
        write_replace(&operation.destination, &operation.contents)?;
    }
    if operation.remove_source && operation.source.exists() {
        fs::remove_file(&operation.source)?;
    }
    Ok(())
}

fn write_exclusive(path: &Path, contents: &[u8]) -> Result<(), AdapterError> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

fn write_replace(path: &Path, contents: &[u8]) -> Result<(), AdapterError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("asa-migrate-{}.tmp", uuid::Uuid::now_v7()));
    write_exclusive(&temporary, contents)?;
    fs::rename(&temporary, path)?;
    if let Some(parent) = path.parent() {
        let directory = fs::File::open(parent)?;
        directory.sync_all()?;
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), AdapterError> {
    let mut contents = serde_json::to_vec_pretty(value)?;
    contents.push(b'\n');
    write_replace(path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn migrates_claude_codex_and_indexes_with_backups() {
        let temp = TempDir::new().unwrap();
        let old = temp.path().join("old project");
        let new = temp.path().join("新 project");
        let config = MigrationConfig {
            claude_config: temp.path().join("claude"),
            codex_home: temp.path().join("codex"),
            journal_root: temp.path().join("asa"),
        };
        let id = "0198d108-6dea-7cc0-8000-000000000001";
        let old_slug = claude_slug(&old);
        let claude = config
            .claude_config
            .join("projects")
            .join(old_slug)
            .join(format!("{id}.jsonl"));
        write(
            &claude,
            &format!(
                "{{\"type\":\"user\",\"cwd\":\"{}\",\"message\":{{\"content\":\"keep\"}}}}\n",
                old.display()
            ),
        );
        let sidecar = claude
            .parent()
            .unwrap()
            .join(id)
            .join("tool-results/result.txt");
        write(&sidecar, "keep verbatim");
        let codex = config
            .codex_home
            .join("sessions/2026/07/29")
            .join(format!("rollout-2026-07-29T00-00-00-{id}.jsonl"));
        write(
            &codex,
            &format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{}\",\"id\":\"{id}\"}}}}\n",
                old.join("sub").display()
            ),
        );
        write(
            &config.codex_home.join("session_index.jsonl"),
            &format!(
                "{{\"id\":\"{id}\",\"workspace_path\":\"{}\",\"title\":\"keep\"}}\n",
                old.display()
            ),
        );

        let dry = migrate_workspace_path(&old, &new, &config, true).unwrap();
        assert!(claude.exists());
        assert_eq!(dry.operations, 4);
        let report = migrate_workspace_path(&old, &new, &config, false).unwrap();
        assert_eq!(report.sessions, 2);
        assert!(!claude.exists());
        let destination = config
            .claude_config
            .join("projects")
            .join(claude_slug(&new))
            .join(format!("{id}.jsonl"));
        assert!(
            fs::read_to_string(destination)
                .unwrap()
                .contains("新 project")
        );
        let moved_sidecar = config
            .claude_config
            .join("projects")
            .join(claude_slug(&new))
            .join(id)
            .join("tool-results/result.txt");
        assert_eq!(fs::read_to_string(moved_sidecar).unwrap(), "keep verbatim");
        assert!(
            fs::read_to_string(codex)
                .unwrap()
                .contains("新 project/sub")
        );
        assert!(report.journal.exists());
        assert_eq!(
            files_below(&report.backup_root).unwrap().len(),
            report.operations
        );
        let resumed = migrate_workspace_path(&old, &new, &config, false).unwrap();
        assert_eq!(resumed, report);
    }

    #[test]
    fn rejects_destination_collisions_before_writes() {
        let temp = TempDir::new().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        let config = MigrationConfig {
            claude_config: temp.path().join("claude"),
            codex_home: temp.path().join("codex"),
            journal_root: temp.path().join("asa"),
        };
        let id = "0198d108-6dea-7cc0-8000-000000000001";
        let source = config
            .claude_config
            .join("projects")
            .join(claude_slug(&old))
            .join(format!("{id}.jsonl"));
        let destination = config
            .claude_config
            .join("projects")
            .join(claude_slug(&new))
            .join(format!("{id}.jsonl"));
        write(&source, &format!("{{\"cwd\":\"{}\"}}\n", old.display()));
        write(&destination, "{}\n");
        let result = plan_workspace_path_migration(&old, &new, &config);
        assert!(result.is_err(), "{result:?}");
        assert_eq!(fs::read_to_string(source).unwrap().lines().count(), 1);
    }
}

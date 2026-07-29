use anyhow::{Context, Result, bail};
use asa_core::AsaPaths;
use directories::BaseDirs;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const LABEL: &str = "com.ak5.asa";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)]
enum Supervisor {
    Launchd,
    Systemd,
}

pub fn install(paths: &AsaPaths, executable: &Path, endpoint: &str) -> Result<PathBuf> {
    let supervisor = platform()?;
    let service = service_path(supervisor)?;
    let contents = render(supervisor, paths, executable, endpoint);
    write_service(&service, &contents)?;
    fs::create_dir_all(paths.logs())?;
    match supervisor {
        Supervisor::Launchd => {
            // Bootout makes reinstall idempotent. A missing prior job is harmless.
            let _ = launchctl(&[
                "bootout",
                &launchd_domain()?,
                service.to_string_lossy().as_ref(),
            ]);
            launchctl(&[
                "bootstrap",
                &launchd_domain()?,
                service.to_string_lossy().as_ref(),
            ])?;
        }
        Supervisor::Systemd => {
            systemctl(&["daemon-reload"])?;
            systemctl(&["enable", "--now", "asa.service"])?;
        }
    }
    Ok(service)
}

pub fn uninstall() -> Result<PathBuf> {
    let supervisor = platform()?;
    let service = service_path(supervisor)?;
    match supervisor {
        Supervisor::Launchd => {
            if service.exists() {
                launchctl(&[
                    "bootout",
                    &launchd_domain()?,
                    service.to_string_lossy().as_ref(),
                ])?;
            }
        }
        Supervisor::Systemd => {
            let _ = systemctl(&["disable", "--now", "asa.service"]);
        }
    }
    if service.exists() {
        fs::remove_file(&service)?;
    }
    if supervisor == Supervisor::Systemd {
        systemctl(&["daemon-reload"])?;
    }
    Ok(service)
}

pub fn start() -> Result<()> {
    match platform()? {
        Supervisor::Launchd => {
            let service = service_path(Supervisor::Launchd)?;
            if !service.exists() {
                bail!("launchd service is not installed: {}", service.display());
            }
            launchctl(&[
                "bootstrap",
                &launchd_domain()?,
                service.to_string_lossy().as_ref(),
            ])
        }
        Supervisor::Systemd => systemctl(&["start", "asa.service"]),
    }
}

pub fn stop() -> Result<()> {
    match platform()? {
        Supervisor::Launchd => {
            let service = service_path(Supervisor::Launchd)?;
            launchctl(&[
                "bootout",
                &launchd_domain()?,
                service.to_string_lossy().as_ref(),
            ])
        }
        Supervisor::Systemd => systemctl(&["stop", "asa.service"]),
    }
}

pub fn restart() -> Result<()> {
    match platform()? {
        Supervisor::Launchd => {
            stop()?;
            start()
        }
        Supervisor::Systemd => systemctl(&["restart", "asa.service"]),
    }
}

pub fn doctor(paths: &AsaPaths) -> Result<Vec<String>> {
    let supervisor = platform()?;
    let service = service_path(supervisor)?;
    let mut findings = Vec::new();
    if !service.exists() {
        findings.push(format!(
            "service definition is missing: {}",
            service.display()
        ));
    } else if fs::read_to_string(&service)
        .map(|contents| !contents.contains(LABEL) && !contents.contains("AI Session Analyzer"))
        .unwrap_or(true)
    {
        findings.push(format!(
            "service definition is unreadable or does not identify ASA: {}",
            service.display()
        ));
    }
    if !paths.token_file().exists() {
        findings.push(format!(
            "daemon token is missing (it is created on first run): {}",
            paths.token_file().display()
        ));
    }
    #[cfg(unix)]
    if let Ok(metadata) = fs::metadata(paths.token_file()) {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            findings.push(format!(
                "daemon token permissions must be user-only: {}",
                paths.token_file().display()
            ));
        }
    }
    for name in ["daemon.log", "daemon.err.log"] {
        let path = paths.logs().join(name);
        if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 10 * 1024 * 1024) {
            findings.push(format!(
                "daemon log exceeds 10 MiB and should be rotated: {}",
                path.display()
            ));
        }
    }
    Ok(findings)
}

pub fn print_logs(paths: &AsaPaths, lines: usize) -> Result<()> {
    match platform()? {
        Supervisor::Launchd => {
            for name in ["daemon.log", "daemon.err.log"] {
                let path = paths.logs().join(name);
                if path.exists() {
                    println!("==> {} <==", path.display());
                    let contents = fs::read_to_string(path)?;
                    for line in contents
                        .lines()
                        .rev()
                        .take(lines)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                    {
                        println!("{line}");
                    }
                }
            }
            Ok(())
        }
        Supervisor::Systemd => command(
            Command::new("journalctl").args([
                "--user-unit",
                "asa.service",
                "--no-pager",
                "-n",
                &lines.to_string(),
            ]),
            "journalctl",
        ),
    }
}

#[allow(clippy::unnecessary_wraps)]
fn platform() -> Result<Supervisor> {
    #[cfg(target_os = "macos")]
    {
        Ok(Supervisor::Launchd)
    }
    #[cfg(target_os = "linux")]
    {
        Ok(Supervisor::Systemd)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        bail!("ASA supervisor integration supports macOS launchd and Linux systemd user services")
    }
}

fn service_path(supervisor: Supervisor) -> Result<PathBuf> {
    let base = BaseDirs::new().context("the platform does not provide a home directory")?;
    Ok(match supervisor {
        Supervisor::Launchd => base
            .home_dir()
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")),
        Supervisor::Systemd => base.config_dir().join("systemd/user/asa.service"),
    })
}

fn render(supervisor: Supervisor, paths: &AsaPaths, executable: &Path, endpoint: &str) -> String {
    match supervisor {
        Supervisor::Launchd => render_launchd(paths, executable, endpoint),
        Supervisor::Systemd => render_systemd(paths, executable, endpoint),
    }
}

fn render_launchd(paths: &AsaPaths, executable: &Path, endpoint: &str) -> String {
    let escaped = |value: &str| {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string><string>--root</string><string>{}</string>
    <string>daemon</string><string>run</string><string>--endpoint</string><string>{}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
        escaped(&executable.to_string_lossy()),
        escaped(&paths.root().to_string_lossy()),
        escaped(endpoint),
        escaped(&paths.logs().join("daemon.log").to_string_lossy()),
        escaped(&paths.logs().join("daemon.err.log").to_string_lossy()),
    )
}

fn render_systemd(paths: &AsaPaths, executable: &Path, endpoint: &str) -> String {
    let quote = |value: &str| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    format!(
        "[Unit]\nDescription=AI Session Analyzer local observability daemon\n\n\
         [Service]\nType=simple\nExecStart={} --root {} daemon run --endpoint {}\n\
         Restart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
        quote(&executable.to_string_lossy()),
        quote(&paths.root().to_string_lossy()),
        quote(endpoint),
    )
}

fn write_service(path: &Path, contents: &str) -> Result<()> {
    let parent = path.parent().context("service path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("asa.tmp");
    fs::write(&temporary, contents)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn launchd_domain() -> Result<String> {
    let output = Command::new("id").arg("-u").output().context("run id -u")?;
    if !output.status.success() {
        bail!("id -u failed");
    }
    Ok(format!(
        "gui/{}",
        String::from_utf8_lossy(&output.stdout).trim()
    ))
}

fn launchctl(arguments: &[&str]) -> Result<()> {
    command(Command::new("launchctl").args(arguments), "launchctl")
}

fn systemctl(arguments: &[&str]) -> Result<()> {
    command(
        Command::new("systemctl").arg("--user").args(arguments),
        "systemctl --user",
    )
}

fn command(command: &mut Command, name: &str) -> Result<()> {
    let status = command.status().with_context(|| format!("run {name}"))?;
    if !status.success() {
        bail!("{name} exited with {status}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn launchd_definition_uses_absolute_paths_and_keepalive() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let rendered = render_launchd(&paths, Path::new("/opt/ASA & tools/asa"), "127.0.0.1:4317");
        assert!(rendered.contains("/opt/ASA &amp; tools/asa"));
        assert!(rendered.contains("<key>KeepAlive</key><true/>"));
        assert!(rendered.contains("127.0.0.1:4317"));
    }

    #[test]
    fn systemd_definition_restarts_and_uses_user_owned_root() {
        let temp = TempDir::new().unwrap();
        let paths = AsaPaths::discover(Some(temp.path())).unwrap();
        let rendered = render_systemd(&paths, Path::new("/usr/local/bin/asa"), "127.0.0.1:4317");
        assert!(rendered.contains("Restart=on-failure"));
        assert!(rendered.contains(temp.path().to_string_lossy().as_ref()));
        assert!(rendered.contains("WantedBy=default.target"));
    }
}

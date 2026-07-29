---
name: teach-dev
description: Teach ASA local setup and verification. Use with $teach-dev, /teach-dev, or "teach me how to develop ASA".
---

# Learn ASA development

Inspect manifests, lockfiles, `mise.toml`, `rust-toolchain.toml`, CI, and current
status first. Run the bootstrap prerequisite checker read-only when available.

## Tool layers

- Workstation: Git; GitHub CLI, mise, ripgrep, and jq support specific workflows.
- Project toolchain: mise pins Node 22 and pnpm 10.34.5;
  `rust-toolchain.toml` pins Rust 1.88.
- Native setup: pnpm installs V1 dependencies; Cargo resolves V2 dependencies.
- Local identity: credentials and transcripts remain outside tracked files.

Label these:

```sh
mise current                    # safe/read-only
rustc --version                 # safe/read-only
node --version                  # safe/read-only
pnpm --version                  # safe/read-only
mise install                    # workstation/project-tool mutation
pnpm install --frozen-lockfile  # local dependency mutation
```

Use the smallest relevant gate:

```sh
cargo test -p <crate>
pnpm test -- <pattern>
```

Before handoff, use the applicable complete native gates from
`CONTRIBUTING.md`. `mise run check-all` is the stable cross-stack boundary; it
exists because no single native runner owns both V1 and V2.

Local daemon testing MUST use an isolated `ASA_ROOT` and unused loopback ports.
Real fixture generation is **secret-sensitive** and can spend account quota;
prefer `pnpm e2e:setup --synthetic`. User hook installation is a persistent
security-relevant mutation.

Useful prompt: “Reproduce this setup failure, identify which tool layer owns it,
and show evidence before changing versions or reinstalling anything.”

Choose one small task, run its narrow test, inspect the diff, then run broader
checks proportional to risk.

Recovery: stop local services, preserve logs, inspect exact version and error,
and reconcile the owning layer. Do not blindly delete all caches or reinstall
global tools.

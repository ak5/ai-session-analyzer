# Repository conventions

This document owns the non-obvious rules that make ASA portable and safe to
maintain. `README.md` owns product identity; this document owns repository
behavior and its rationale.

## Repository bootstrap

- Profile: **Full** maintained mixed-stack product.
- Canonical entry points: `README.md`, `docs/index.md`, `CONTRIBUTING.md`,
  `AGENTS.md`, and `CLAUDE.md`.
- Command ownership: Cargo owns Rust V2 commands; pnpm owns TypeScript V1
  commands; mise pins cross-stack tools and owns only the combined verification
  boundary.
- Enabled bundles: entry points, conventions, agent operation, teaching,
  documentation parity, decision memory, PR workflow, environment, and Vibe
  Session readiness.
- Intentionally omitted bundles: starter adoption, hosted deployment, and
  Dependabot. Renovate already owns dependency updates.
- Vibe Session readiness: enabled.

## Repository shape and ownership

ASA is a mixed workspace during the V2 migration:

- `crates/` is the Rust V2 distribution. It MUST remain buildable as one `asa`
  executable.
- `packages/`, `scripts/`, and the TypeScript root configuration are the retained
  V1 behavioral oracle and deferred-feature implementation.
- `fixtures/v2/` owns sanitized cross-implementation fixtures.
- `docs/adr/` owns accepted architecture decisions.
- `.github/workflows/rust*.yml` owns V2 CI and native release artifacts.
- `.github/workflows/test.yml` and `publish.yml` own V1 CI and npm publication.

Contributors MUST NOT silently move a feature between V1 and V2. A change that
alters the migration boundary MUST update ADR 001 and the parity documentation.

## Native commands and mise

Use native runners for stack-local work:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --locked --release --workspace
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm e2e:setup --synthetic
pnpm test:e2e
```

`mise.toml` pins Node and pnpm. `rust-toolchain.toml` remains the Rust version
owner. The `mise run check-all` task is justified because it provides one stable
operator boundary across two native build systems; it does not replace their
individual commands.

## Scratch workspace

The repository-root `tmp/` directory is a predictable disposable workspace. The
root-anchored `/tmp/` ignore rule prevents scratch files from polluting Git
without hiding nested directories named `tmp`.

- Use `tmp/<task-name>/` to avoid collisions.
- Never treat content under `tmp/` as durable source, documentation, or evidence.
- Move retained artifacts into their authoritative tracked location.
- Clean up only scratch files created by the current task.
- MUST NOT store credentials or secrets under `tmp/`.

## Branches, pull requests, and releases

ASA uses a staged-release profile:

| Path | Required integration method |
| --- | --- |
| `feature/*` → `dev` | Squash one result, or rebase an approved commit series |
| `integrate/*` → `dev` | Squash or approved-series rebase |
| `dev` → `main` | Merge commit |
| `hotfix/*` → `main` | Merge commit |
| `main` → `dev` | Merge commit |

`dev` is the accepted integration history. `main` is production release
history. An author CAN rewrite an author-owned feature branch with
`--force-with-lease`. An agent MUST NOT rewrite `dev`, `main`, or another
person's branch.

A pull request is a proposal. One merge-ready result SHOULD squash into `dev`.
A meaningful series CAN rebase-merge only when every preserved commit passes
independently. A maintainer uses `integrate/pr-N` for a material rewrite and
MUST request fresh CI and review. A rebase, force push, or material change
invalidates earlier approval.

Before a release, record the exact `dev` SHA and run:

```sh
git fetch origin
git log --oneline origin/main..origin/dev
git diff --stat origin/main...origin/dev
```

The `dev` → `main` PR MUST use **Create a merge commit**. Afterward:

```sh
git fetch origin
git merge-base --is-ancestor <released-dev-sha> origin/main
git log --first-parent --oneline origin/main
```

Tag the resulting `main` merge commit. A production hotfix starts from `main`;
after release, merge `main` into `dev` with ancestry preserved. Do not use a
merge queue.

GitHub capability status at bootstrap:

- `dev` is the default branch: **enforced**.
- `dev` and `main` pull-request and `quality-gates` protection: **enforced**.
- `dev` and `main` force-push/deletion blocking, stale-review dismissal, and
  conversation resolution: **enforced**.
- one required approving review: **unavailable on plan** for the current
  solo-maintainer workflow; both branches require zero approvals.
- merge commits on `main` and absence of linear-history enforcement: **enforced**.
- required Rust checks: **unknown** until the workflow runs successfully.

## Documentation ownership

| Changed surface | Documentation owner |
| --- | --- |
| CLI commands, flags, or defaults | `README.md`, relevant operations/reference doc, and CLI help |
| Adapter or transcript behavior | `docs/formats.md`, `docs/adding-an-agent.md`, and relevant ADR |
| OTLP schema or semantic convention | ADR 003 and V2 verification |
| Durable storage, recovery, or deletion | ADR 004, ADR 006, and V2 operations |
| Session projection or DuckDB schema | ADR 005 and V2 verification |
| Privacy behavior | ADR 006 and V2 operations |
| Test command or fixture layout | `docs/testing.md` and V2 verification |
| CI check or release behavior | `CONTRIBUTING.md`, `docs/publishing.md`, and PR templates |
| Workspace membership or ownership | this document and `AGENTS.md`/`CLAUDE.md` |

Run the repository-local `doc-code-parity` skill after behavior or workflow
changes. Mechanical drift SHOULD be fixed with the implementation. Judgment
calls and suspected code regressions MUST be reported rather than rewritten
away.

Accepted architecture decisions are indexed in `docs/adr/index.md`. The
repo-local `intent-farm` skill CAN recover candidates from repository evidence,
but a maintainer MUST accept exact candidate text before it becomes policy.

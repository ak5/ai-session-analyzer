# ASA repository contract

ASA is a local AI-session analyzer migrating from a TypeScript V1 behavioral
oracle to one distributed Rust V2 executable. Durable documentation starts at
`docs/index.md`.

## Read first

1. Read `README.md` for product status and the fastest successful path.
1. Read `docs/index.md` for the authoritative documentation map.
1. Read `docs/conventions.md` for ownership, branch, release, and documentation
   policy.
1. Read `CONTRIBUTING.md` before preparing a pull request.
1. Read the relevant ADR before changing a V2 architecture boundary.

## Repository ownership

- `crates/` owns Rust V2 and MUST produce one `asa` executable.
- `packages/` and TypeScript root files own retained V1 behavior.
- `fixtures/v2/` owns sanitized parity fixtures.
- `docs/adr/` owns accepted V2 decisions.
- `.github/workflows/rust*.yml` owns native V2 CI and release artifacts.
- `.github/workflows/test.yml` and `publish.yml` own V1 CI and npm publication.

Do not silently port, retire, or duplicate a feature across the V1/V2 boundary.
Update ADR 001 and parity documentation when that boundary changes.

## Verification

For Rust changes, run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --locked --release --workspace
```

For TypeScript changes, run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm e2e:setup --synthetic
pnpm test:e2e
```

Use `mise run check-all` only when the full cross-stack gate is appropriate.

## Safety and privacy

- Use isolated `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `ASA_ROOT` values in tests.
- MUST NOT commit real credentials, authentication files, or unsanitized
  transcripts.
- MUST NOT weaken native agent trust or hook-security controls.
- MUST NOT modify native transcript stores during analysis or ordinary tests.
- Treat user-scoped hook installation as a persistent security-relevant change.
- Preserve unrelated working-tree changes.
- Avoid destructive Git and filesystem operations without explicit authority.

## Documentation

Follow the ownership map in `docs/conventions.md`. A behavior, flag, schema,
path, workflow, or default change MUST update its owning documentation. Run the
repository-local `doc-code-parity` skill before handoff. Report a suspected code
regression or judgment conflict instead of rewriting intended documentation to
match it.

## Scratch workspace

Use the gitignored repository-root `tmp/` directory for disposable scratch files
and intermediate artifacts.

- Use `tmp/<task-name>/` to avoid collisions.
- Never treat anything under `tmp/` as durable source, documentation, or evidence.
- Move artifacts worth retaining into their proper tracked location.
- Clean up only scratch files created by your task.
- Do not use `tmp/` as a credential or secret store.

## Git and releases

Target feature pull requests at `dev`. Agents MUST NOT rewrite `dev`, `main`, or
another person's branch. Use `--force-with-lease` only on an author-owned feature
branch.

One merge-ready result normally squash-merges into `dev`. Preserve a commit
series only when every commit passes independently. Use `integrate/pr-N` for a
maintainer rewrite and require fresh CI and review.

A `dev` to `main` release MUST use a merge commit so the recorded `dev` SHA
remains an ancestor of `main`. A hotfix merges into `main`, then `main` merges
back into `dev`. Do not use a merge queue.

Use the separate global `vibe-session` workflow to manage one intended outcome.
The repo-local `pr-ready`, `pr-create`, `pr-review`, and `doc-code-parity`
skills own repository-specific preparation, handoff, and review behavior. Use
`intent-farm` to propose evidence-backed ADR candidates; only a maintainer can
accept them as repository policy.

---
name: doc-code-parity
description: Audit ASA documentation against implementation and workflows. Use with $doc-code-parity, /doc-code-parity, "check doc/code drift", or add "all" for a repository-wide sweep.
---

# ASA doc/code parity

Keep documented commands, behavior, paths, schemas, defaults, and ownership in
step with the mixed Rust V2 and TypeScript V1 repository.

## Scope

Without `all`, inspect the working and staged diff plus nearby docs and comments
that name changed symbols. With `all`, inspect every durable document, manifest,
workflow, CLI help surface, and relevant code comment.

Start read-only:

```sh
git status --short
git diff --stat
git diff --cached --stat
rg --files README.md docs AGENTS.md CLAUDE.md CONTRIBUTING.md SECURITY.md .github
cargo metadata --no-deps --format-version 1
pnpm -r list --depth -1
target/release/asa --help
pnpm asa --help
```

Build a claim list before editing. Classify each mismatch:

- **mechanical drift**: stale path, flag, command, default, count, link, or name;
- **judgment**: code and prose conflict but intended behavior is unclear;
- **missing ownership**: a changed surface has no documentation owner;
- **possible code bug**: prose describes an intentional invariant that code breaks.

Fix mechanical drift minimally. Do not rewrite intent to legitimize a possible
regression. Consolidate judgment calls for the operator.

## ASA ownership map

| Changed surface | Documentation owner |
| --- | --- |
| CLI command, flag, or default | `README.md`, CLI help, relevant operations/reference doc |
| Adapter or transcript behavior | `docs/formats.md`, `docs/adding-an-agent.md`, relevant ADR |
| OTLP or semantic convention | ADR 003 and V2 verification |
| Storage, recovery, deletion | ADR 004, ADR 006, V2 operations |
| Projection or analytics schema | ADR 005 and V2 verification |
| Privacy | ADR 006, V2 operations, SECURITY |
| Test or fixture layout | `docs/testing.md`, V2 verification |
| CI or release workflow | CONTRIBUTING, publishing, PR templates |
| V1/V2 migration boundary | ADR 001, parity doc, README |
| Workspace ownership | conventions and shared agent contract |

## Verification

Check Markdown links and referenced paths. Confirm:

```sh
cmp -s AGENTS.md CLAUDE.md
rg -n '^/tmp/$' .gitignore
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build
pnpm test
```

Run broader or expensive checks when the changed claims require them. Never use
real credentials or unsanitized transcripts for parity evidence.

Report:

- fixed mechanical drift;
- unresolved judgment calls;
- possible code bugs;
- missing ownership;
- areas verified clean;
- exact checks run.

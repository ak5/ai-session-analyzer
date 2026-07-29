---
name: teach-repo
description: Teach an operator how ASA is organized and how to direct an agent safely. Use with $teach-repo, /teach-repo, or "teach me this repository".
---

# Learn the ASA repository

Inspect `git status`, `README.md`, `docs/index.md`, `docs/conventions.md`,
`AGENTS.md`, manifests, and current branch before teaching. Adapt the lesson to
the working tree; do not assume it is clean.

## Mental model

ASA has two implementation eras in one repository:

- `crates/`: Rust V2, one native `asa` executable, passive hooks, durable
  observations, projections, and analytics.
- `packages/`: TypeScript V1, retained as a behavioral oracle and home of
  deferred features.
- `fixtures/v2/`: sanitized cross-implementation evidence.
- `docs/adr/`: decisions; `docs/index.md`: navigation;
  `docs/conventions.md`: operating policy.

Cargo owns V2 checks. pnpm owns V1 checks. `mise run check-all` crosses both
systems. Local ASA data and agent transcripts are private inputs, not fixtures.

## Safe first tour

Label these as **safe/read-only**:

```sh
git status --short
git log --oneline --decorate -8
cargo metadata --no-deps --format-version 1
pnpm -r list --depth -1
target/release/asa --help
```

Useful prompts:

1. “Inspect the Rust V2 ingestion path and explain the durability boundary with
   file references. Do not edit.”
2. “Compare this V1 behavior with its V2 parity evidence and flag gaps.”
3. “Diagnose this failing test; reproduce it before proposing a fix.”
4. “Add one sanitized adapter fixture and update its owning docs.”
5. “Run doc/code parity on my current diff and fix mechanical drift only.”

Choose one small real task. Ask the agent to state desired outcome, constraints,
affected V1/V2 boundary, and verification before editing.

## Authority labels

- **Safe/read-only:** inspect files, status, help, tests already known not to mutate
  external state.
- **Local mutation:** edit source/docs, generate synthetic fixtures.
- **GitHub mutation:** create issues/PRs, push, change settings.
- **Destructive:** delete data, rewrite history, uninstall hooks.
- **Secret-sensitive:** auth files, transcripts, bearer tokens, user hooks.

Require a diff and exact test output as evidence. Vibe Session is a separate
workflow for one intended outcome; it consumes this repository contract.

Cheat sheet: README → docs index → conventions → AGENTS. Rust is V2; TypeScript
is V1. Recover by stopping, inspecting `git diff`, and reverting only changes
whose ownership is clear.

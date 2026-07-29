---
name: pr-create
description: Prepare an honest ASA pull-request proposal using repository policy. Use with $pr-create, /pr-create, "create the PR", or "turn this work into a PR".
---

# Create an ASA pull request

Preserve the operator's actual intent, accepted scope, evidence, caveats, known
warts, risks, rollback, documentation parity, and excluded follow-up work.

## Inspect first

```sh
git status --short
git diff --stat
git diff
git log --oneline --decorate -10
git branch -vv
```

Read `CONTRIBUTING.md`, `docs/conventions.md`, and the pull request template.
Use the repo-local `doc-code-parity` skill. Confirm the branch targets current
`dev`; do not create a feature PR against `main`.

Use concise outcome-oriented titles matching repository history, for example:

- `fork --context: crafted-context forks that beat native compaction`
- `Cost estimation: API-equivalent $ in analyze and compare`
- `Rust V2: authenticated durable OTLP ingestion`

Complete every template section. List exact checks, not “tests pass.” State
which V1/V2 surfaces are unaffected. Identify sensitive fixture provenance.

## Preflight

Run applicable native checks from `CONTRIBUTING.md`. Use
`mise run check-all` for cross-stack changes. Confirm the final diff contains no
credentials, auth files, unsanitized transcripts, generated build output, or
unrelated changes.

One merge-ready result normally squash-merges into `dev`. Request a rebase merge
only when every preserved commit independently passes and the sequence has
permanent review, rollback, or migration value.

An author CAN rebase an author-owned feature branch and push with
`--force-with-lease`. Never force-push a contributor-owned branch, `dev`, or
`main`. Do not enable auto-merge or merge without explicit authority.

For `dev` to `main`, use the release template, record the exact `dev` SHA, and
require a merge commit. Never squash or rebase a release PR.

Before any `gh pr create`, show the proposed title, body, base, head, labels, and
reviewers. Opening the PR is a GitHub mutation and needs explicit authority.

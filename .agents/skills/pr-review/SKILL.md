---
name: pr-review
description: Review an ASA pull request against code, privacy, migration, and staged-release policy. Use with $pr-review, /pr-review, or "review this PR".
---

# Review an ASA pull request

Read the PR, changed files, comments, checks, `CONTRIBUTING.md`, and
`docs/conventions.md`. Review the submitted revision, not a summary.

## Review checklist

- The base is `dev` for feature work or `main` only for `dev` releases and
  reviewed `hotfix/*` work.
- The change has one outcome and preserves the V1/V2 migration boundary.
- Rust V2 remains one executable with passive observation and neutral hooks.
- Native transcripts remain untouched during analysis and ordinary tests.
- Authentication, privacy, retention, deletion, and crash behavior fail safely.
- Fixtures are synthetic or deliberately sanitized.
- Bounded queues, durable acknowledgement, and rebuildable analytics invariants
  remain intact where relevant.
- Applicable Rust and TypeScript checks passed on the current revision.
- Documentation ownership and doc/code parity are satisfied.
- Risk, rollback, uncertainty, and excluded work are explicit.

Classify the proposal as: squash, approved series, maintainer rewrite, split, or
do not merge. Every preserved commit in an approved series MUST pass
independently.

For each comment choose:

- **apply**: fix in a new commit and reply with its SHA;
- **push back**: reply with concrete reasoning and resolve;
- **split**: create and link an approved follow-up issue, then resolve.

Resolve a GitHub review thread only after its disposition is complete. A rebase,
force push, maintainer rewrite, or material change invalidates earlier approval
and requires fresh checks and review.

For a maintainer rewrite, use `integrate/pr-N`, link the source PR, explain
differences, preserve meaningful attribution, and never rewrite the
contributor-owned branch.

For a release PR, verify `dev` → `main`, the recorded source SHA, successful
checks, merge-commit availability, and absence of linear-history enforcement.
After explicit merge authority, the permitted command is
`gh pr merge <number> --merge`. Do not recommend a merge queue.

Do not post reviews, mutate branches, resolve threads, or merge without explicit
authority. End with findings ordered by severity, evidence, check status, and a
clear merge disposition.

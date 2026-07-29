---
name: teach-ship
description: Teach how ASA work moves from outcome to reviewed release. Use with $teach-ship, /teach-ship, or "teach me how to ship this".
---

# Learn to ship ASA changes

Inspect status, branch, issue/PR state, checks, and release policy before
teaching. Separate implemented, merged, published, and installed states.

## Outcome to proposal

1. Define one outcome, constraints, exclusions, and rollback.
1. Work on `feature/*` from current `dev`.
1. Ask the agent to inspect before editing.
1. Review the diff and doc/code parity.
1. Run applicable checks.
1. Create focused commits.
1. Use `$vibe-session finish` or `/vibe-session finish`.
1. Use repo-local `pr-ready` to reconcile an author-owned branch with current
   `dev` and rerun verification.
1. Use repo-local `pr-create` for a ready PR, draft PR, or honest no-PR result.

Prompt: “Implement this outcome within the stated V1/V2 boundary. Preserve
private data, show the diff and exact checks, and stop before GitHub mutations.”

Feature PRs normally squash into `dev`. An approved series can rebase-merge only
when each commit passes. Review comments are applied, pushed back with evidence,
or split into an approved issue. A material rewrite needs fresh CI and review.

## Release

Record the exact `dev` SHA. Review:

```sh
git log --oneline origin/main..origin/dev
git diff --stat origin/main...origin/dev
```

The `dev` → `main` PR MUST use **Create a merge commit**. After explicit merge
authority, verify the recorded SHA is an ancestor of `main`, then tag the
resulting merge commit. Squash or rebase would break the reusable ancestry.

A hotfix starts at `main`, merges into `main`, then `main` merges into `dev`.
Do not teach cherry-pick as the normal return path. Do not use a merge queue.

Authority: inspect/check is **safe**; edit/commit is **local mutation**;
push/PR/review/merge/release is **GitHub mutation**; publication is
**external publication**; user hooks are **security-sensitive**; reset, force
push, and deletion are **risky/destructive**.

Choose one small real outcome and require diff, checks, PR checks, release SHA,
artifact evidence, and rollback evidence as applicable. Never merge, publish,
or install during teaching without explicit authority.

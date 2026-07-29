---
name: pr-ready
description: Make an author-owned ASA proposal current, coherent, and verified before PR handoff. Use with $pr-ready, /pr-ready, "get my PR ready", "rebase this PR onto dev", or "make this branch merge-ready".
---

# Make an ASA proposal PR-ready

Prepare an author-owned short-lived branch for review without rewriting shared
history or hiding uncertainty. A current, coherent, verified branch is easier
to review and more likely to merge without maintainer reconstruction.

For a teaching-only request, explain this workflow without changing files,
commits, branches, remotes, or pull requests.

## Establish authority and state

Read `CONTRIBUTING.md`, `docs/conventions.md`, the pull request template, and
the open PR when one exists. Resolve the actual PR base; normal feature work
targets `dev`.

Inspect:

```sh
git status --short
git branch -vv
git log --oneline --decorate -15
git diff --stat
git diff
gh pr status
```

Confirm that the current branch is short-lived and owned by the operator.
Refuse to rewrite `dev`, `main`, any release/shared branch, or another
contributor's branch. Preserve unrelated and pre-existing work. Require a clean,
understood worktree before rebasing.

Fetch the remote read-only, then show:

```sh
git fetch origin
git rev-list --left-right --count origin/<base>...HEAD
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
```

Do not use `git pull --rebase` as an opaque substitute.

## Classify and propose

Classify the proposal as one of:

- one commit;
- review series;
- durable series;
- split;
- maintainer rewrite;
- not ready.

One coherent result normally becomes one commit. Preserve a durable series only
when each commit has one permanent purpose and independently builds and passes
applicable checks. Do not preserve broken workshop checkpoints.

Show the current and proposed commit plan. Explain every combine, reorder,
reword, or preserved boundary. Get explicit approval before rebasing, amending,
resetting, or otherwise rewriting commits.

## Rebase and verify

After approval, rebase the author-owned branch onto the current remote base:

```sh
git rebase origin/<base>
```

Resolve conflicts according to the proposal's established intent. Abort and ask
when intent is ambiguous. Do not merge the base into a feature branch merely to
avoid a policy-required rebase.

Run the repo-local `doc-code-parity` skill and applicable native gates from
`CONTRIBUTING.md`. Use `mise run check-all` for cross-stack work. For a durable
series, verify every preserved commit independently.

Compare the final base-to-head diff and commit list with the PR's stated intent.
Surface unrelated changes, generated churn, hidden migrations, stale
documentation, caveats, security/privacy effects, rollback concerns, and known
warts.

## Remote update and handoff

Show the old and new head SHAs and the exact push operation. Get explicit
approval before updating a rewritten remote branch:

```sh
git push --force-with-lease origin <branch>
```

Never use `--force`. Rebasing normally preserves commit author identity even
though SHAs change. Never invent authorship, signatures, or co-author trailers.

A rewrite or material change invalidates earlier approval and requires fresh CI
and review. Hand the verified branch to the repo-local `pr-create` skill for
the final title, body, labels, reviewers, and evidence.

Report `PR-ready` only when the branch is based on the current remote base, the
diff is one coherent proposal, its commit structure matches the classification,
required checks and documentation parity pass, and no conflict, ambiguity, or
hidden failure remains. Otherwise report `needs author work`, `needs split`,
`needs maintainer rewrite`, or `not ready`, with the smallest next action.

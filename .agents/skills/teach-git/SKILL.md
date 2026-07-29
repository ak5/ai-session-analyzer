---
name: teach-git
description: Teach ASA's staged Git and pull-request workflow. Use with $teach-git, /teach-git, or "teach me Git for this repo".
---

# Learn Git in ASA

Inspect the current branch, status, remotes, recent history, and
`docs/conventions.md` before teaching.

## Mental model

The working tree is uncommitted work. A commit is a recoverable local snapshot.
A branch names a line of work. A remote branch is shared. A pull request is a
proposal, not a promise to merge.

ASA uses:

```text
feature/* → dev → main
hotfix/*  → main → dev
```

One result normally squash-merges into `dev`. A meaningful series can
rebase-merge only when every commit passes independently. Releases from `dev`
to `main` MUST use a merge commit.

## Read-only practice

Label these **safe/read-only**:

```sh
git status --short
git diff
git diff --cached
git log --oneline --decorate --graph -12
git log --first-parent --oneline main
git branch -vv
```

Explain stage, commit, push, PR, checks, review, and merge using the live output.
Show the release ancestry check without substituting a fake SHA:

```sh
git merge-base --is-ancestor <released-dev-sha> origin/main
```

An author CAN rebase an author-owned `feature/*` branch and use
`--force-with-lease`. Never rewrite `dev`, `main`, or another person's branch.
A rebase, force push, or material rewrite invalidates old approval.
Use the repo-local `pr-ready` skill to show the proposed commit rewrite and
request approval before the rebase or remote update.

A maintainer rewrite uses `integrate/pr-N`, links the original proposal,
preserves meaningful attribution, and receives fresh CI and review. Broken,
unsafe, obsolete, or too-costly work can remain unmerged.

Choose a real small change. Ask the agent: “Inspect first, keep one outcome,
show me the diff and checks, and do not commit or push without asking.”

Authority: diff/log are **safe**; edits/stage/commit are **local mutations**;
push/issue/PR/review are **GitHub mutations**; reset, branch deletion, force
push, and history rewriting are **risky or destructive**.

Recovery: stop, run `git status` and `git diff`, preserve unknown work, and ask
for a target-specific recovery plan. Do not reach reflexively for reset.

# Contributing to ASA

Start with [README.md](README.md), then read [the documentation index](docs/index.md)
and [repository conventions](docs/conventions.md). Report vulnerabilities through
[SECURITY.md](SECURITY.md), not a public issue.

## Setup and verification

Install the pinned tools with `mise install` when mise is available. Use Cargo
and pnpm directly for stack-local work.

Rust V2:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --locked --release --workspace
```

TypeScript V1:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm e2e:setup --synthetic
pnpm test:e2e
```

Run the smallest relevant checks while iterating. Run every applicable check
before requesting integration. `mise run check-all` runs the complete mixed-stack
gate.

## Branches and scope

Create `feature/<topic>` from current `dev`. Keep one outcome per pull request.
An author CAN update an author-owned branch with:

```sh
git fetch origin
git rebase origin/dev
git push --force-with-lease
```

An author MUST NOT rewrite `dev`, `main`, or another person's branch. A change
MUST NOT modify native Claude or Codex transcript stores. Tests MUST use
isolated homes and ASA roots.

## Merge-ready work

A merge-ready proposal MUST:

- use current `dev` as its base;
- have no merge conflict;
- contain one clear result and no unrelated changes;
- pass applicable checks after its final rebase;
- include evidence and necessary documentation;
- explain material security, migration, operational, and rollback effects;
- identify generated changes and important uncertainty.

Use the pull request template. Documentation changes MUST follow the ownership
map in `docs/conventions.md`.

## Pull requests and attribution

A pull request is a proposal. It does not guarantee integration or preservation
of the submitted implementation.

We normally squash one coherent proposal into `dev`. We CAN rebase-merge a
meaningful commit series when every preserved commit passes independently.

A maintainer can split, squash, rebase, reconstruct, replace, reject, or leave a
proposal unmerged. For a material rewrite, the maintainer uses
`integrate/pr-N`, links the original pull request, and requests fresh CI and
review. The maintainer MUST NOT silently rewrite a contributor-owned branch.

We preserve meaningful attribution. The contributor remains the commit author
when the accepted commit substantially contains their work. We use
`Co-authored-by` when contributor and maintainer work are both material. The
maintainer becomes the author when the implementation is substantially replaced.
Attribution does not guarantee preservation of a particular diff, commit
sequence, or implementation.

A rebase, force push, maintainer rewrite, or material change invalidates earlier
approval and MUST receive fresh CI and review.

## Releases and hotfixes

A release pull request goes from `dev` to `main` and MUST use a merge commit.
Record the release-source `dev` SHA and verify afterward that it is an ancestor
of `main`. Tag the resulting `main` merge commit. See
[docs/conventions.md](docs/conventions.md) and use the release PR template.

Create urgent production fixes from `main` as `hotfix/*`. Merge the reviewed fix
into `main`, then merge `main` into `dev` without rewriting history.

## Release

- Release-source `dev` SHA: `<!-- exact 40-character SHA -->`
- Version/tag: `<!-- vX.Y.Z or v2.X.Y.Z -->`

## Preflight

- [ ] The base is `main` and the head is `dev`.
- [ ] `git log --oneline origin/main..origin/dev` was reviewed.
- [ ] `git diff --stat origin/main...origin/dev` was reviewed.
- [ ] Applicable TypeScript and Rust checks passed.
- [ ] Release notes cover security, privacy, migration, operations, and known gaps.
- [ ] Package or artifact versions match the intended tag.

## Integration

This release MUST use **Create a merge commit**. Do not squash or rebase this
pull request. The recorded release-source SHA must remain an ancestor of `main`.

## Post-release

- [ ] `git merge-base --is-ancestor <released-dev-sha> origin/main` succeeds.
- [ ] The tag points to the resulting `main` merge commit.
- [ ] Native artifacts or npm publication completed as intended.
- [ ] Any production hotfix was merged back from `main` into `dev`.

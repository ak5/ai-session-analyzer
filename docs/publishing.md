# Publishing

ASA uses staged releases: feature work enters `dev`, and a release pull request
merges `dev` into `main` with a merge commit. Read
[repository conventions](conventions.md) before releasing. Record the exact
release-source `dev` SHA and verify after the merge that it remains an ancestor
of `main`.

## Rust V2 native artifacts

V2 distributes one native `asa` executable. Tags matching `v2.*` run
`.github/workflows/rust-release.yml`, which builds locked release binaries for:

- Apple Silicon macOS;
- Intel macOS;
- x86_64 GNU/Linux.

The workflow uses GitHub's supported macOS 15 ARM and Intel runner labels.
Hyphenated versions such as alpha, beta, and release-candidate tags become
GitHub prereleases and do not replace the latest stable release.

The workflow packages each binary as a compressed archive, writes a SHA-256
checksum, uploads the build artifacts, and attaches them to the GitHub release.
Before tagging:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --locked --release --workspace
```

Tag the `main` merge commit only after the `dev` → `main` release PR completes
and its recorded source SHA passes the ancestry check.

## TypeScript V1 npm shape

The published artifact is **`@ak5/asa` only**: the CLI, esbuild-bundled to
`dist/bundle.mjs` with all `@asa/*` workspace packages **and** commander inlined —
zero runtime dependencies, MIT licensed. The workspace packages stay private and
are `devDependencies` of the CLI, so `pnpm publish` can never emit unresolvable
`workspace:*` ranges into the manifest.

Bundling notes:

- ESM output with a `createRequire` banner — CJS deps (commander) call
  `require('node:…')` for builtins, which an ESM bundle must shim.
- `bin/asa.js` is a two-line shim importing the bundle, so a raw symlink to it
  works as a dev install (the bundle is self-contained after `pnpm build`).
- The name `asa` collides with a POSIX relic (`/usr/bin/asa`, Fortran
  carriage-control, shipped by Xcode's toolchain). Irrelevant for npm installs —
  package-manager bin dirs precede `/usr/bin` — but a raw symlink must land in a
  PATH dir that does too.

## Verify V1 without publishing

```sh
pnpm build && cd packages/cli && npm pack        # inspect: LICENSE, README, bin/, dist/bundle.mjs
npm i -g --prefix /tmp/asa-check <tarball>
/tmp/asa-check/bin/asa --version && /tmp/asa-check/bin/asa list
```

## V1 release through CI

Pushing a `v1.*` tag runs `.github/workflows/publish.yml`: full quality gates
(build, unit, synthetic e2e), a tag ↔ `packages/cli` version match check, then
`pnpm publish` with npm **provenance** — the published tarball is attested to
the exact workflow run that built it.

One-time setup: create an npm **automation token** for the `@ak5` scope
(npmjs.com → Access Tokens) and add it as the `NPM_TOKEN` repo secret.

So a V1 release is: bump `packages/cli` version → release PR `dev` → `main`
using a merge commit → verify the recorded `dev` SHA is reachable from `main` →
tag the resulting `main` merge commit → push the tag.

V2 tags do not start this npm workflow. Tags matching `v2.*` exclusively use
the Rust native-artifact workflow, so a Rust release cannot fail or publish
because the retained V1 package has a different version.

## V1 manual fallback

1. `npm login` as the owner of the `@ak5` scope.
1. `cd packages/cli && pnpm publish` — `prepublishOnly` gates on the full
   workspace build + test suite; `publishConfig.access: public` handles the
   scoped-package default.

Name availability, checked 2026-07: `asa` and `asa-cli` are taken on npm;
`ai-session-analyzer` was free; the `@ak5` scope requires owning that npm
account/org.

# Publishing

## Shape

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

## Verify without publishing

```sh
pnpm build && cd packages/cli && npm pack        # inspect: LICENSE, README, bin/, dist/bundle.mjs
npm i -g --prefix /tmp/asa-check <tarball>
/tmp/asa-check/bin/asa --version && /tmp/asa-check/bin/asa list
```

## Release (deliberately manual)

1. `npm login` as the owner of the `@ak5` scope.
2. `cd packages/cli && pnpm publish` — `prepublishOnly` gates on the full
   workspace build + test suite; `publishConfig.access: public` handles the
   scoped-package default.

Name availability, checked 2026-07: `asa` and `asa-cli` are taken on npm;
`ai-session-analyzer` was free; the `@ak5` scope requires owning that npm
account/org.

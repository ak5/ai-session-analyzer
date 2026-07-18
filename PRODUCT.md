# PRODUCT.md — asa (ai session analyzer)

## Register

product — the only visual surface is generated HTML report pages (`--html` on every
report command). Design serves the data; the tool's identity lives in the terminal.

## Users & Purpose

Developers who drive Claude Code / Codex CLI daily and treat their sessions as a
dataset. They open an asa report to answer one question fast — what did this session
cost, which step do I fork, did my CLAUDE.md rule work — then leave. Reports are also
shared (a teammate gets `asa-prompter.html` in Slack), so pages must stand alone with
zero context and zero network.

## Personality

Terminal-native: a beautifully typeset terminal capture, not a web dashboard.
Committed monospace, column-aligned data, restrained color. The page should feel like
the CLI graduated, not like the CLI was skinned.

Three words: precise, dense, calm.

## Anti-references

- Generic SaaS dashboard chrome (cards, KPI tiles, gradient accents).
- Phosphor-green "hacker terminal" cosplay — terminal-native is a typographic
  commitment, not a CRT theme.
- Web-app affordances that lie: nothing on these pages is interactive except
  scrolling; don't decorate as if it were.

## Hard requirements

- Fully designed light AND dark via `prefers-color-scheme`; both must pass ≥4.5:1
  body contrast.
- Self-contained single file: no webfonts, no CDN, no JS. Pages get emailed,
  attached, and archived.
- Wide tables (session ids, 9-column aggregates) scroll horizontally inside their
  own container; the page never scrolls sideways.

## Strategic design principles

1. Tables are the product — real `<table>` semantics, numeric right-alignment,
   sticky headers in tall scrolls.
2. One accent, used only for structure (headings, links, current markers) — never
   decoration. Lint severity (warn/info) keeps its own semantic colors.
3. Density is a feature; whitespace is rhythm between sections, not padding inside
   data.

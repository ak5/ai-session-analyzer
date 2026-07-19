# DESIGN.md — asa HTML reports

Visual system for the pages `renderHtmlReport` (packages/core) emits. One template,
eight report types; consistency across them is the point.

## Theme

Dual (light + dark) via `prefers-color-scheme`, `color-scheme: light dark`. OKLCH
throughout. Neutrals carry a 0.004–0.008 chroma tint toward the accent hue (210).

| token | light | dark |
|---|---|---|
| `--bg` | `oklch(0.98 0.003 210)` | `oklch(0.18 0.008 220)` |
| `--surface` | `oklch(0.955 0.004 210)` | `oklch(0.22 0.01 220)` |
| `--ink` | `oklch(0.24 0.012 220)` | `oklch(0.88 0.008 210)` |
| `--muted` | `oklch(0.45 0.015 220)` | `oklch(0.68 0.012 210)` |
| `--accent` | `oklch(0.48 0.09 210)` | `oklch(0.75 0.09 205)` |
| `--warn` | `oklch(0.5 0.13 65)` | `oklch(0.78 0.13 75)` |
| `--info` | `oklch(0.48 0.1 250)` | `oklch(0.75 0.09 245)` |
| `--rule` | `oklch(0.87 0.006 210)` | `oklch(0.32 0.01 220)` |

Accent hue 210 (steel-cyan): cool, technical, deliberately not phosphor green.
Muted must still pass 4.5:1 against bg (it is metadata, but it is read).

## Typography

- Single family: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for
  everything — headings, meta, data. Terminal-native commitment; zero webfonts.
- Fixed rem scale, ratio ≈1.2: body 13px/1.55; h1 1.25rem/700; h2 0.9rem/700
  uppercase-free; meta 0.85em.
- Tables: 12.5px, `font-variant-numeric: tabular-nums`, numeric columns
  right-aligned.

## Layout & components

- Page: max-width 110ch, centered, 2rem block rhythm; sections separated by
  1.75rem.
- **Table**: parsed from the report's column-aligned text into semantic
  `<table>`; `thead` sticky within an `overflow-x/y` wrapper (max-height 60vh for
  tall tables); zebra-free — row hover tint instead; 1px `--rule` under header.
- **Section heading (h2)**: accent-colored, preceded by rhythm space.
- **Lint lines**: `[warn]`/`[info]` badge colored by severity, message in ink;
  example lines (`e.g. …`) in muted.
- **Key-value / prose lines**: rendered in a `pre` block preserving the report's
  own alignment.
- No cards, no borders-as-decoration, no motion (static document; nothing changes
  state).

## Print

Not currently a requirement; browser defaults acceptable.

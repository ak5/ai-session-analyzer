---
name: intent-farm
description: Recover ASA architectural intent from repository evidence and propose ADR candidates without declaring policy. Use with $intent-farm, /intent-farm, "farm intent", or an explicit PR, issue, tag, range, or subsystem.
---

# Farm ASA decision intent

Recover durable architectural intent from repository-authorized evidence.
Implementation proves behavior, not intent. Never publish a candidate as policy
without maintainer acceptance.

## Scope and evidence

Support:

- `$intent-farm` or `/intent-farm`: inspect the natural boundary since the
  latest accepted ADR or release;
- `$intent-farm all` or `/intent-farm all`: inspect all accessible history;
- `$intent-farm <scope>`: inspect an explicit PR, issue, tag, commit range, or
  subsystem.

If no natural boundary exists, ask one concise scope question. Read
`docs/adr/index.md` and `docs/conventions.md` first. List accessible evidence
before analysis.

Use only:

- accepted or superseded ADRs;
- merged PRs, resolved review, and linked issues;
- issue decisions and closure reasons;
- commits, merge commits, and releases;
- repository docs, runbooks, conventions, code comments, tests, and current
  implementation.

Do not inspect private chat, email, credentials, hidden reasoning, or unrelated
personal data. Rank accepted ADRs and explicit maintainer decisions above
merged rationale, issue decisions, stable tested implementation, and isolated
commit messages.

## Candidate analysis

Correlate evidence by links, identifiers, paths, and chronology. Separate:

- explicit decisions;
- inferred intent;
- accidental implementation;
- conflicting or reversed evidence;
- likely supersession.

Propose only durable decisions that explain a problem or constraint, the chosen
direction, rejected or deferred alternatives, future constraints, and material
consequences. Exclude routine implementation details, formatting preferences,
temporary fixes, and ordinary reference facts.

Write draft evidence only under `tmp/intent-farm/<scope>/`. Use one candidate
file per decision:

```text
Candidate:
Proposed status: proposed | accepted | superseded | deprecated
Context:
Decision:
Alternatives:
Consequences:
Evidence:
Conflicting evidence:
Confidence: high | medium | low
Current-code check:
Suggested ADR path:
```

Confidence describes evidence quality, not importance. Mark inferred language
explicitly and preserve contributor attribution and source links.

## Maintainer review and publication

Show one compact candidate batch. The maintainer can accept, amend, merge,
record as superseded history, defer, or reject each candidate.

Create or update tracked ADRs only after the maintainer accepts the exact
candidates. Follow the existing `docs/adr/NNN-*.md` convention, update
`docs/adr/index.md` and relevant cross-links, then run the repo-local
`doc-code-parity` skill against every accepted claim.

Do not turn a merged PR, current implementation, or agent inference into
repository policy by itself.

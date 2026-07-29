---
name: teach-debug
description: Teach evidence-led debugging in ASA. Use with $teach-debug, /teach-debug, or "teach me how to debug this".
---

# Learn to debug ASA

Inspect current status and the relevant implementation boundary before teaching.
Ask the operator for desired behavior, observed behavior, minimal reproduction,
exact error, input type, platform, and recent changes.

## Debugging loop

1. Reproduce without editing.
2. Bound the problem: Rust V2, TypeScript V1, native adapter, storage, daemon,
   analytics, packaging, or documentation.
3. Form two or three falsifiable hypotheses.
4. Gather evidence that distinguishes them.
5. Fix the root cause with the smallest coherent change.
6. Add or tighten a regression test.
7. Run narrow, then risk-proportional verification.

Useful prompts:

- “Reproduce this failure with synthetic data and list hypotheses ranked by
  evidence. Do not edit yet.”
- “Trace this observation from adapter through durable acknowledgement to
  projection, citing functions and invariants.”
- “Determine whether this is documentation drift or a code regression.”

Authority labels:

- Source inspection, logs, status, and synthetic reproduction: **safe/read-only**
  when they do not start external mutations.
- Code/test edits: **local mutation**.
- Real agent execution: **quota- and privacy-sensitive**.
- User hook changes: **persistent security mutation**.
- GitHub issue/PR updates: **GitHub mutation**.
- Deleting ASA/native data: **destructive**.

Choose one real defect. Require the failing test before the fix when practical,
the passing test after it, and the final diff. For concurrency or durability,
require evidence at the acknowledgement/crash boundary, not only a happy path.

Recovery: stop, retain the reproduction and logs in an appropriate safe
location, revert only the isolated attempted fix, and report what remains
unknown. Never use private transcripts as convenient fixtures.

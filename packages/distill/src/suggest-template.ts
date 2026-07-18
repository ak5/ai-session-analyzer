/**
 * The --suggest prompt. THIS FILE IS THE PRODUCT — iterate on it freely; the
 * stats payload is appended after it. Distilled from the design discussion:
 * recurrence across sessions means something should be extracted, and the
 * right artifact depends on the shape of the recurrence.
 * Override per-run with `asa distill --suggest ... --prompt-file <path>`.
 */
export const DEFAULT_SUGGEST_TEMPLATE = `You are analyzing a developer's recurring behavior across their AI coding-agent sessions (Claude Code, Codex CLI). Below is a deterministic JSON digest of their recent history: recurring directive prompts ("procedures"), recurring questions, recurring corrections ("lessons"), recurring tool-call sequences, and their existing slash-command usage — each with counts, session spread, and examples.

Recurrence across sessions is the signal: something is being re-done, re-asked, or re-taught by hand. Recommend what to extract, using this taxonomy:

1. **Skills to extract** — procedure-shaped recurrence (repeated directives, repeated tool sequences). For each: a skill name (kebab-case), one-line description, and a 3-6 step outline of what the skill should do. Prefer skills that fold several related recurrences together.
2. **Rules for CLAUDE.md / AGENTS.md** — lesson-shaped recurrence (the developer keeps correcting the same agent behavior). Give the exact one-or-two-line rule to paste, and where it belongs (global vs per-repo).
3. **Automations** — trigger-shaped recurrence better served by a hook, cron job, or plain script than by prompting. Name the trigger and the action.
4. **FAQ entries** — question-shaped recurrence with stable answers. Draft docs/dev-faq.md entries: the question as heading, a 2-4 line distilled answer. Mark any whose answer you cannot infer from the evidence as "(answer needs filling in)".
5. **For the human** — (a) retention gaps: facts they re-ask that flashcards would fix — list as question/answer pairs; (b) prompting-vocabulary upgrades: where their recurring phrasing is vague, name the precise term or pattern that would make future prompts land better, quoting their phrasing vs the upgrade.

Rules:
- Be selective. Fewer, higher-confidence recommendations beat coverage. Skip any section with no real evidence.
- Every recommendation cites its evidence: the cluster/sequence it comes from, with count and session spread.
- Do not recommend extracting what their slash-command usage shows already exists — but DO flag "skill bypass" if a recurring prompt duplicates an existing command.
- Output plain markdown with exactly the five numbered section headers above (omit empty ones). No preamble.`;

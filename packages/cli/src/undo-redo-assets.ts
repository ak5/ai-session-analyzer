/**
 * Vendored /undo /redo tooling (EXPERIMENTAL, installed only via
 * `asa setup --undo-redo`). Stack files live in .jj/ — self-ignored by both
 * VCSs. Claude turns are marked by the asa git-trace hook (marker-gated);
 * Codex has no hook surface, so its skills fall back to the previous op-log
 * entry when the stack is empty — one-level undo, honest about it.
 */

const CLAUDE_PREAMBLE = 'Run this bash command and report only its stdout output (no narration):';

const undoBash = (sid: string, marked: boolean) => `\`\`\`bash
UNDO=".jj/undo-stack-${sid}"
REDO=".jj/redo-stack-${sid}"

[[ -d .jj ]]    || { echo "no jj here — run \\\`asa setup\\\` and opt into jj + undo/redo"; exit 0; }
jj st >/dev/null 2>&1 || true

current=$(jj op log --limit 1 --no-graph -T 'self.id().short()')
if [[ -s "$UNDO" ]]; then
  target=$(tail -1 "$UNDO")
  sed -i '' '$d' "$UNDO" 2>/dev/null || sed -i '$d' "$UNDO"
${
  marked
    ? `else
  echo "nothing to undo"; exit 0`
    : `else
  # no marked turns (codex has no prompt hooks) — fall back to the previous op:
  # undoes the most recent change batch; deeper undo needs marked turns
  target=$(jj op log --limit 2 --no-graph -T 'self.id().short()++"\\n"' | tail -1)`
}
fi
[[ -n "$target" && "$target" != "$current" ]] || { echo "nothing to undo"; exit 0; }

echo "$current" >> "$REDO"
preview=$(jj diff --from "$target" --to "$current" --stat 2>/dev/null | tail -8)
jj op restore "$target" >/dev/null 2>&1

echo "↩  undone — restored to op $target"
[[ -n "$preview" ]] && echo "" && echo "$preview"

und=$(wc -l <"$UNDO" 2>/dev/null | tr -d ' '); und=\${und:-0}
red=$(wc -l <"$REDO" | tr -d ' ')
echo ""
echo "(undo: $und remaining; redo: $red available)"
\`\`\``;

const redoBash = (sid: string) => `\`\`\`bash
UNDO=".jj/undo-stack-${sid}"
REDO=".jj/redo-stack-${sid}"

[[ -d .jj ]]    || { echo "no jj here — run \\\`asa setup\\\` and opt into jj + undo/redo"; exit 0; }
[[ -s "$REDO" ]] || { echo "nothing to redo (a new prompt clears the redo stack)"; exit 0; }

current=$(jj op log --limit 1 --no-graph -T 'self.id().short()')
target=$(tail -1 "$REDO")

sed -i '' '$d' "$REDO" 2>/dev/null || sed -i '$d' "$REDO"
echo "$current" >> "$UNDO"

preview=$(jj diff --from "$current" --to "$target" --stat 2>/dev/null | tail -8)
jj op restore "$target" >/dev/null 2>&1

echo "↪  redone — restored to op $target"
[[ -n "$preview" ]] && echo "" && echo "$preview"

und=$(wc -l <"$UNDO" | tr -d ' ')
red=$(wc -l <"$REDO" | tr -d ' ')
echo ""
echo "(undo: $und available; redo: $red remaining)"
\`\`\``;

const stackBash = (sid: string) => `\`\`\`bash
UNDO=".jj/undo-stack-${sid}"
REDO=".jj/redo-stack-${sid}"

[[ -d .jj ]] || { echo "no jj here"; exit 0; }

echo "═══ undo/redo stacks (${sid}) ═══"
echo ""
if [[ -s "$UNDO" ]]; then
  echo "undo stack ($(wc -l <"$UNDO" | tr -d ' ') turns; top first) --"
  tac "$UNDO" 2>/dev/null || tail -r "$UNDO"
else
  echo "undo stack -- (empty)"
fi
echo ""
if [[ -s "$REDO" ]]; then
  echo "redo stack ($(wc -l <"$REDO" | tr -d ' ') turns; top first) --"
  tac "$REDO" 2>/dev/null || tail -r "$REDO"
else
  echo "redo stack -- (empty)"
fi
echo ""
echo "current op -- $(jj op log --ignore-working-copy --limit 1 --no-graph -T 'self.id().short()')"
\`\`\``;

const resetBash = (sid: string) => `\`\`\`bash
UNDO=".jj/undo-stack-${sid}"
REDO=".jj/redo-stack-${sid}"

[[ -d .jj ]] || { echo "no jj here"; exit 0; }

und=0; red=0
[[ -s "$UNDO" ]] && und=$(wc -l <"$UNDO" | tr -d ' ')
[[ -s "$REDO" ]] && red=$(wc -l <"$REDO" | tr -d ' ')
: > "$UNDO"
: > "$REDO"
echo "🧹 stacks cleared (was undo: $und, redo: $red)"
\`\`\``;

const CLAUDE_SID = '${CLAUDE_SESSION_ID:-default}';
const sidLine = `SID="${CLAUDE_SID}"\n`;

// Claude command files: SID from the session env, injected as first bash line.
function claudeCommand(description: string, bash: string): string {
  return `---\ndescription: ${description}\n---\n\n${CLAUDE_PREAMBLE}\n\n${bash.replace('```bash\n', '```bash\n' + sidLine)}\n`;
}

export const CLAUDE_UNDO_COMMANDS: Record<string, string> = {
  'undo.md': claudeCommand(
    "Undo the agent's most recent turn (multi-undo OK; pair with /redo)",
    undoBash('${SID}', true),
  ),
  'redo.md': claudeCommand(
    'Redo a turn that was undone (only valid before submitting a new prompt)',
    redoBash('${SID}'),
  ),
  'undo-stack.md': claudeCommand(
    'Show the undo/redo stacks (read-only inspection)',
    stackBash('${SID}'),
  ),
  'undo-reset.md': claudeCommand(
    'Clear the undo/redo stacks (use after manual jj op restore)',
    resetBash('${SID}'),
  ),
};

// Codex skills: fixed shared stack (codex sets no session env), op-log fallback.
function codexSkill(name: string, description: string, bash: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${CLAUDE_PREAMBLE}\n\n${bash}\n`;
}

export const CODEX_UNDO_SKILLS: Record<string, string> = {
  undo: codexSkill(
    'undo',
    "Undo the agent's recent file changes via the jj op log. With no marked turns, undoes the most recent change batch (one level); pair with $redo.",
    undoBash('codex', false),
  ),
  redo: codexSkill(
    'redo',
    'Redo changes undone by $undo (only valid before further edits).',
    redoBash('codex'),
  ),
  'undo-stack': codexSkill(
    'undo-stack',
    'Show the $undo/$redo stacks (read-only inspection).',
    stackBash('codex'),
  ),
  'undo-reset': codexSkill(
    'undo-reset',
    'Clear the $undo/$redo stacks (use after manual jj op restore).',
    resetBash('codex'),
  ),
};

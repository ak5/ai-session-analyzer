/**
 * Recurring tool-call sequence mining: the same n-gram of tool invocations
 * across many sessions is a procedure being re-performed by hand — skill bait.
 */
import type { NormalizedSession, ToolCall } from '@asa/core';

export interface SequenceStat {
  sequence: string[];
  count: number;
  sessions: string[];
}

/** First real command word of a shell string: skips env-var assignments and wrapper shells. */
function shellVerb(commandText: string): string | undefined {
  const tokens = commandText.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  if (['bash', 'sh', 'zsh'].includes(tokens[i]?.split('/').pop() ?? '') && /^-l?c$/.test(tokens[i + 1] ?? '')) {
    return shellVerb(tokens.slice(i + 2).join(' ').replace(/^['"]/, ''));
  }
  return tokens[i]?.split('/').pop();
}

/**
 * Bash/exec calls are opaque by name — qualify them with the leading command
 * word. Codex `exec` args are JavaScript source invoking
 * `tools.exec_command({"cmd":"…"})` (or an apply-patch blob), not plain JSON.
 */
export function toolLabel(call: ToolCall): string {
  const input = call.input;
  let commandText: string | undefined;
  if (call.name === 'Bash' && typeof input === 'object' && input !== null) {
    const c = (input as { command?: unknown }).command;
    if (typeof c === 'string') commandText = c;
  } else if (typeof input === 'string') {
    if (input.includes('*** Begin Patch')) return `${call.name}:apply_patch`;
    // cmd key may be JSON ("cmd":) or a JS object-literal key (cmd:)
    const cmdMatch = /["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
    if (cmdMatch) {
      commandText = cmdMatch[1]!.replace(/\\(.)/g, '$1');
    } else {
      try {
        const parsed = JSON.parse(input) as { command?: unknown; cmd?: unknown };
        const c = parsed.command ?? parsed.cmd;
        if (typeof c === 'string') commandText = c;
        else if (Array.isArray(c)) commandText = c.join(' ');
      } catch {
        // free-form JS/args without a cmd — fall through to the bare name
      }
    }
  }
  if (commandText) {
    const word = shellVerb(commandText);
    if (word) return `${call.name}:${word}`;
  }
  return call.name;
}

export interface SequenceOptions {
  minN?: number;
  maxN?: number;
  minCount?: number;
  minSessions?: number;
  top?: number;
}

export function mineToolSequences(
  sessions: NormalizedSession[],
  options: SequenceOptions = {},
): SequenceStat[] {
  const { minN = 2, maxN = 4, minCount = 3, minSessions = 2, top = 12 } = options;
  // sequences of only unqualified shell/wait calls say "the agent ran commands" — noise
  const generic = new Set(['exec', 'wait', 'shell', 'local_shell', 'Bash']);
  const stats = new Map<string, { count: number; sessions: Set<string> }>();

  for (const session of sessions) {
    for (const step of session.steps) {
      const labels = step.toolCalls.map(toolLabel);
      for (let n = minN; n <= maxN; n++) {
        for (let i = 0; i + n <= labels.length; i++) {
          const key = labels.slice(i, i + n).join(' → ');
          let entry = stats.get(key);
          if (!entry) {
            entry = { count: 0, sessions: new Set() };
            stats.set(key, entry);
          }
          entry.count += 1;
          entry.sessions.add(session.id);
        }
      }
    }
  }

  return [...stats.entries()]
    .filter(([, s]) => s.count >= minCount && s.sessions.size >= minSessions)
    .map(([key, s]) => ({ sequence: key.split(' → '), count: s.count, sessions: [...s.sessions] }))
    .filter((s) => s.sequence.some((label) => !generic.has(label)))
    // longer recurring sequences are more procedure-shaped — weight by length
    .sort((a, b) => b.count * b.sequence.length - a.count * a.sequence.length)
    .slice(0, top);
}

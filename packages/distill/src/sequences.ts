/**
 * Recurring tool-call sequence mining: the same n-gram of tool invocations
 * across many sessions is a procedure being re-performed by hand — skill bait.
 */
import { shellVerb, toolCommandText, type NormalizedSession, type ToolCall } from '@asa/core';

export interface SequenceStat {
  sequence: string[];
  count: number;
  sessions: string[];
}

/**
 * Bash/exec calls are opaque by name — qualify them with the leading command
 * word (extraction handles both agents' arg shapes, see core's toolCommandText).
 */
export function toolLabel(call: ToolCall): string {
  if (typeof call.input === 'string' && call.input.includes('*** Begin Patch')) {
    return `${call.name}:apply_patch`;
  }
  const commandText = toolCommandText(call);
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

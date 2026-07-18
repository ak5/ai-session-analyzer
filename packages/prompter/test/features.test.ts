import { describe, expect, it } from 'vitest';
import { extractPromptFeatures, findVagueMarkers } from '../src/features.js';

describe('extractPromptFeatures', () => {
  it('detects file paths and code anchors', () => {
    const f = extractPromptFeatures('fix the bug in packages/core/src/index.ts around `parseJsonl`');
    expect(f.hasPath).toBe(true);
    expect(f.hasCode).toBe(true);
    expect(f.isCorrection).toBe(false);
  });

  it('detects vague fillers, with duplicates counted', () => {
    const f = extractPromptFeatures('analyze mcps, etc etc and maybe caching or something idk');
    expect(f.vagueMarkers).toContain('etc');
    expect(f.vagueMarkers.filter((m) => m === 'etc')).toHaveLength(2);
    expect(f.vagueMarkers).toContain('or something');
    expect(f.vagueMarkers).toContain('idk');
  });

  it('detects corrections and questions', () => {
    expect(extractPromptFeatures('no, I meant the other file').isCorrection).toBe(true);
    expect(extractPromptFeatures('actually, revert that').isCorrection).toBe(true);
    expect(extractPromptFeatures('please fix the tests').isCorrection).toBe(false);
    expect(extractPromptFeatures('how does the parser work?').isQuestion).toBe(true);
    expect(extractPromptFeatures('fix the parser').isQuestion).toBe(false);
  });

  it('detects enumerations', () => {
    expect(extractPromptFeatures('do these:\n1. build\n2. test').hasEnumeration).toBe(true);
    expect(extractPromptFeatures('- item one\n- item two').hasEnumeration).toBe(true);
    expect(extractPromptFeatures('just one thing').hasEnumeration).toBe(false);
  });

  it('scores specific prompts above vague ones', () => {
    const specific = extractPromptFeatures(
      'update packages/cli/src/index.ts: add a `--json` flag to the list command and cover it in e2e/asa.e2e.test.ts',
    );
    const vague = extractPromptFeatures('make it better somehow, etc');
    expect(specific.specificity).toBeGreaterThan(vague.specificity);
    expect(specific.specificity).toBeGreaterThanOrEqual(8);
    expect(vague.specificity).toBeLessThanOrEqual(4);
  });

  it('clamps specificity to 0..10', () => {
    expect(extractPromptFeatures('').specificity).toBeGreaterThanOrEqual(0);
    expect(extractPromptFeatures('x'.repeat(50)).specificity).toBeLessThanOrEqual(10);
  });
});

describe('findVagueMarkers', () => {
  it('matches across whitespace and is case-insensitive', () => {
    expect(findVagueMarkers('Or  Something like this')).toContain('or something');
    expect(findVagueMarkers('etcetera')).toHaveLength(0);
  });
});

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedSession } from './index.js';

/** USD per million tokens. cacheWrite only applies to agents that bill it (Claude). */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Keys are model-id prefixes; longest prefix wins after normalization. */
export type PricingTable = Record<string, ModelRates>;

/**
 * Published API list prices. Deliberately conservative: only models whose
 * pricing is known are listed — an unknown model makes the estimate partial
 * and gets named in the report, rather than being priced by guesswork.
 * Extend or override via ~/.asa/pricing.json (same shape, merged over this).
 */
export const BUILTIN_PRICING: PricingTable = {
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
};

export function pricingOverridePath(): string {
  return join(homedir(), '.asa', 'pricing.json');
}

/** Builtin table with ~/.asa/pricing.json merged over it (absent/invalid file ignored). */
export function loadPricing(overridePath: string = pricingOverridePath()): PricingTable {
  try {
    const user = JSON.parse(readFileSync(overridePath, 'utf8')) as PricingTable;
    return { ...BUILTIN_PRICING, ...user };
  } catch {
    return BUILTIN_PRICING;
  }
}

/** "claude-haiku-4-5-20251001" → "claude-haiku-4-5"; "gpt-5.6-sol (low)" → "gpt-5.6-sol". */
function normalizeModelId(model: string): string {
  return model
    .replace(/\s*\(.*\)$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase();
}

/**
 * Longest match of the normalized model id against the table's keys. A key
 * matches exactly or at a `-` boundary ("claude-haiku-4-5" covers
 * "claude-haiku-4-5-20251001") — never mid-version: "gpt-5" must not price
 * "gpt-5.6-sol", whose rates are unknown.
 */
export function resolveModelRates(model: string, table: PricingTable): ModelRates | undefined {
  const id = normalizeModelId(model);
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    const k = key.toLowerCase();
    if ((id === k || id.startsWith(`${k}-`)) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

export interface CostEstimate {
  /** API-list-price cost of the priced portion, USD. */
  usd: number;
  /** Models whose usage is included in usd. */
  pricedModels: string[];
  /** Models seen in the session but missing from the pricing table. */
  unpricedModels: string[];
}

/**
 * Estimate a session's API-equivalent cost from its usage totals.
 *
 * Token semantics differ per agent and matter here: Claude's inputTokens
 * exclude cache reads/writes (each billed at its own rate); Codex's
 * inputTokens include the cached subset (billed at the discounted rate,
 * no write charge). Multi-model sessions prorate the shared input/cache
 * totals by each model's output-token share (fallback: API-call share) —
 * per-model input isn't recorded, so this is an estimate by construction.
 *
 * Subscription usage has no marginal cost; this is what the same tokens
 * would cost at API list prices. Returns undefined when the session used
 * no models (nothing to price).
 */
export function estimateSessionCost(
  session: Pick<NormalizedSession, 'usage' | 'modelUsage' | 'models' | 'agent'>,
  table: PricingTable = BUILTIN_PRICING,
): CostEstimate | undefined {
  // '<synthetic>' is Claude's pseudo-model for system-generated turns — not billable.
  const models = Object.keys(session.modelUsage ?? {}).filter((m) => !m.startsWith('<'));
  if (!models.length) return undefined;

  const usage = session.usage;
  const entries = models.map((m) => ({ model: m, ...session.modelUsage![m]! }));
  const outputTotal = entries.reduce((n, e) => n + e.outputTokens, 0);
  const callTotal = entries.reduce((n, e) => n + e.apiCalls, 0);
  const share = (e: (typeof entries)[number]) =>
    outputTotal > 0 ? e.outputTokens / outputTotal : callTotal > 0 ? e.apiCalls / callTotal : 0;

  const estimate: CostEstimate = { usd: 0, pricedModels: [], unpricedModels: [] };
  for (const e of entries) {
    const rates = resolveModelRates(e.model, table);
    if (!rates) {
      estimate.unpricedModels.push(e.model);
      continue;
    }
    estimate.pricedModels.push(e.model);
    const s = share(e);
    const cacheRead = usage.cacheReadTokens * s;
    const uncachedInput =
      session.agent === 'codex'
        ? Math.max(0, usage.inputTokens * s - cacheRead)
        : usage.inputTokens * s;
    const perM = 1 / 1_000_000;
    estimate.usd +=
      uncachedInput * perM * rates.input +
      e.outputTokens * perM * rates.output +
      cacheRead * perM * (rates.cacheRead ?? rates.input) +
      usage.cacheCreationTokens * s * perM * (rates.cacheWrite ?? rates.input * 1.25);
  }
  return estimate;
}

/** "$12.34", "$0.0042" — enough precision to be meaningful at both ends. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

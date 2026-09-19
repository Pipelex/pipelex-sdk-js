import type { RunResults, TokensUsageRecord } from "./runs.js";

/**
 * `summarizeUsage` — one run-level reading of a run's usage pair.
 *
 * A completed run reports usage as `RunResults.tokens_usages` (one record per inference call)
 * beside `RunResults.usage_assembly_error`, and the wire carries no run-level aggregate. This
 * module folds the pair into a single summary under the rules `docs/run-usage.md` states, so
 * every consumer reads the same totals instead of re-deriving them:
 *
 * - a `null` cost is unrated (the model has no rate table), a `0` cost is priced at zero;
 * - `input` and `output` are the only additive token categories (`input_cached` is a subset of
 *   `input`, and summing every category double-counts);
 * - a null list means usage is unavailable, and only `usage_assembly_error` says it broke;
 * - an empty list is a run that did no inference, which costs `0`, not `null`.
 *
 * Pure: no I/O, no client, and the input is never mutated.
 */

/**
 * Which of the three readings of `tokens_usages` the summary describes:
 * - `records` — a non-empty list: the totals are folded from it.
 * - `no_inference` — `[]`: usage assembly ran and no inference happened, so the cost is `0`
 *   and the token totals are zero.
 * - `unavailable` — the list is null or absent: usage assembly was off, it broke (then
 *   `assembly_error` is non-null), or on the hosted path the run was delivered before the
 *   usage artifact existed. Nothing is known, so the cost and the token totals are `null`.
 */
export type UsageSummaryState = "records" | "no_inference" | "unavailable";

/**
 * The two additive token totals. Each is the sum of that category over the records that
 * reported it, and `null` when no record reported it at all — which is different from a
 * reported `0`.
 */
export interface UsageTokenTotals {
  input: number | null;
  output: number | null;
}

/** One pipe's share of a run's usage — the same fold as the run level, over its calls only. */
export interface PipeUsageSummary {
  /** The pipe that made the calls; `null` groups the calls the runtime did not attribute. */
  pipe_code: string | null;
  /** Sum of the priced calls' costs in USD; `null` when none of this pipe's calls was priced. */
  total_cost_usd: number | null;
  /** True when this pipe mixes priced and unrated calls, so `total_cost_usd` is a lower bound. */
  cost_partial: boolean;
  tokens: UsageTokenTotals;
  /** Number of inference calls this pipe made. */
  calls: number;
}

/** A run's usage pair folded into one null-aware reading. */
export interface UsageSummary {
  state: UsageSummaryState;
  /**
   * Sum of the priced calls' costs in USD. `0` for `no_inference`. `null` for `records` when no
   * call was priced (unrated), and for `unavailable`, where nothing is known — read `state`
   * first to tell the two apart.
   */
  total_cost_usd: number | null;
  /**
   * True when priced and unrated calls are mixed, so `total_cost_usd` covers the priced calls
   * only and is a lower bound. Never true outside `records`.
   */
  cost_partial: boolean;
  tokens: UsageTokenTotals;
  /** Number of usage records summarized — one per inference call; `0` outside `records`. */
  calls: number;
  /**
   * `usage_assembly_error` as relayed: non-null when the runner's usage assembly failed, which
   * is the only thing that separates a broken assembly from an `unavailable` one that was off.
   */
  assembly_error: string | null;
  /**
   * Per-pipe rollup, most expensive first: priced pipes by cost descending, then unrated pipes,
   * with ties broken by call count (descending) and then by pipe code. Empty outside `records`.
   */
  by_pipe: PipeUsageSummary[];
}

/** The part of `RunResults` the summary reads — a whole `RunResults` is accepted as is. */
export type RunUsagePair = Pick<RunResults, "tokens_usages" | "usage_assembly_error">;

interface UsageFold {
  total_cost_usd: number | null;
  cost_partial: boolean;
  tokens: UsageTokenTotals;
}

/**
 * Fold a run's usage pair into one summary: run totals, the call count, the assembly error and
 * a per-pipe rollup. See `docs/run-usage.md` for the rules it applies.
 *
 * Pre-contract records, relayed verbatim from artifacts written before the usage contract,
 * carry no `cost` and no `pipe_code`: they count as unrated and unattributed. The legacy
 * `job_metadata` / `unit_costs` fields are relics and are never read.
 */
export function summarizeUsage(results: RunUsagePair): UsageSummary {
  const records = results.tokens_usages;
  const assemblyError = results.usage_assembly_error ?? null;

  if (records == null) {
    return {
      state: "unavailable",
      total_cost_usd: null,
      cost_partial: false,
      tokens: { input: null, output: null },
      calls: 0,
      assembly_error: assemblyError,
      by_pipe: [],
    };
  }

  if (records.length === 0) {
    return {
      state: "no_inference",
      total_cost_usd: 0,
      cost_partial: false,
      tokens: { input: 0, output: 0 },
      calls: 0,
      assembly_error: assemblyError,
      by_pipe: [],
    };
  }

  return {
    state: "records",
    ...foldRecords(records),
    calls: records.length,
    assembly_error: assemblyError,
    by_pipe: rollUpByPipe(records),
  };
}

/** Null-aware totals over a non-empty set of records. */
function foldRecords(records: readonly TokensUsageRecord[]): UsageFold {
  let pricedSum = 0;
  let anyPriced = false;
  let anyUnrated = false;
  let inputSum: number | null = null;
  let outputSum: number | null = null;

  for (const record of records) {
    // `typeof` rather than `!= null`: a pre-contract record has no `cost` key at all.
    if (typeof record.cost === "number") {
      pricedSum += record.cost;
      anyPriced = true;
    } else {
      anyUnrated = true;
    }

    const byCategory = record.nb_tokens_by_category;
    if (byCategory != null) {
      // Only the two joined totals are additive; every other category is a subset of one.
      const input = byCategory["input"];
      const output = byCategory["output"];
      if (typeof input === "number") inputSum = (inputSum ?? 0) + input;
      if (typeof output === "number") outputSum = (outputSum ?? 0) + output;
    }
  }

  return {
    total_cost_usd: anyPriced ? pricedSum : null,
    cost_partial: anyPriced && anyUnrated,
    tokens: { input: inputSum, output: outputSum },
  };
}

/** Group the records by `pipe_code` (a `null` key gathers the unattributed calls) and sort. */
function rollUpByPipe(records: readonly TokensUsageRecord[]): PipeUsageSummary[] {
  const groups = new Map<string | null, TokensUsageRecord[]>();
  for (const record of records) {
    const pipeCode = typeof record.pipe_code === "string" ? record.pipe_code : null;
    const group = groups.get(pipeCode);
    if (group === undefined) {
      groups.set(pipeCode, [record]);
    } else {
      group.push(record);
    }
  }

  const rows: PipeUsageSummary[] = [];
  for (const [pipeCode, pipeRecords] of groups) {
    const fold = foldRecords(pipeRecords);
    rows.push({
      pipe_code: pipeCode,
      total_cost_usd: fold.total_cost_usd,
      cost_partial: fold.cost_partial,
      tokens: fold.tokens,
      calls: pipeRecords.length,
    });
  }

  return rows.sort(comparePipeRows);
}

/** Cost descending with unrated pipes last, then calls descending, then pipe code (null last). */
function comparePipeRows(a: PipeUsageSummary, b: PipeUsageSummary): number {
  if (a.total_cost_usd !== b.total_cost_usd) {
    if (a.total_cost_usd === null) return 1;
    if (b.total_cost_usd === null) return -1;
    return b.total_cost_usd - a.total_cost_usd;
  }
  if (a.calls !== b.calls) return b.calls - a.calls;
  if (a.pipe_code === b.pipe_code) return 0;
  if (a.pipe_code === null) return 1;
  if (b.pipe_code === null) return -1;
  return a.pipe_code < b.pipe_code ? -1 : 1;
}

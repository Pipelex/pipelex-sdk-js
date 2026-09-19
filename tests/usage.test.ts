import { describe, expect, it } from "vitest";
import { summarizeUsage } from "../src/index.js";
import type { RunResults, TokensUsageRecord, UsageSummary } from "../src/index.js";

/** A record as the current runtime emits it: the full key set, a missing value is `null`. */
function record(overrides: Partial<TokensUsageRecord> = {}): TokensUsageRecord {
  return {
    model_type: "llm",
    inference_model_name: "gpt-4o",
    inference_model_id: "gpt-4o-2024-11-20",
    pipe_code: "summarize",
    job_category: "llm_job",
    unit_job_id: "llm_gen_text",
    nb_tokens_by_category: { input: 100, output: 20 },
    cost: 0.01,
    started_at: "2026-09-18T10:00:00Z",
    completed_at: "2026-09-18T10:00:02Z",
    ...overrides,
  };
}

describe("summarizeUsage — unavailable", () => {
  it("reads a null list with no error as unavailable, with nothing known", () => {
    const summary = summarizeUsage({ tokens_usages: null, usage_assembly_error: null });
    expect(summary).toEqual<UsageSummary>({
      state: "unavailable",
      total_cost_usd: null,
      cost_partial: false,
      tokens: { input: null, output: null },
      calls: 0,
      assembly_error: null,
      by_pipe: [],
    });
  });

  it("carries the assembly error when usage assembly broke", () => {
    const summary = summarizeUsage({
      tokens_usages: null,
      usage_assembly_error: "failed to read pipeline events",
    });
    expect(summary.state).toBe("unavailable");
    expect(summary.assembly_error).toBe("failed to read pipeline events");
    expect(summary.total_cost_usd).toBeNull();
    expect(summary.by_pipe).toEqual([]);
  });

  it("reads an absent pair as unavailable", () => {
    const summary = summarizeUsage({});
    expect(summary.state).toBe("unavailable");
    expect(summary.assembly_error).toBeNull();
    expect(summary.tokens).toEqual({ input: null, output: null });
  });
});

describe("summarizeUsage — no_inference", () => {
  it("reads an empty list as a run that did no inference: zero cost, zero tokens", () => {
    const summary = summarizeUsage({ tokens_usages: [], usage_assembly_error: null });
    expect(summary).toEqual<UsageSummary>({
      state: "no_inference",
      total_cost_usd: 0,
      cost_partial: false,
      tokens: { input: 0, output: 0 },
      calls: 0,
      assembly_error: null,
      by_pipe: [],
    });
  });
});

describe("summarizeUsage — records: cost", () => {
  it("sums the priced calls", () => {
    const summary = summarizeUsage({
      tokens_usages: [record({ cost: 0.25 }), record({ cost: 0.5 })],
      usage_assembly_error: null,
    });
    expect(summary.state).toBe("records");
    expect(summary.total_cost_usd).toBe(0.75);
    expect(summary.cost_partial).toBe(false);
    expect(summary.calls).toBe(2);
  });

  it("keeps a zero cost as priced, not unrated", () => {
    const summary = summarizeUsage({
      tokens_usages: [record({ cost: 0 }), record({ cost: 0 })],
      usage_assembly_error: null,
    });
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.cost_partial).toBe(false);
  });

  it("reports a null total when no call was priced", () => {
    const summary = summarizeUsage({
      tokens_usages: [record({ cost: null }), record({ cost: null })],
      usage_assembly_error: null,
    });
    expect(summary.state).toBe("records");
    expect(summary.total_cost_usd).toBeNull();
    expect(summary.cost_partial).toBe(false);
  });

  it("flags a partial total when priced and unrated calls mix", () => {
    const summary = summarizeUsage({
      tokens_usages: [record({ cost: 0.5 }), record({ cost: null }), record({ cost: 0 })],
      usage_assembly_error: null,
    });
    expect(summary.total_cost_usd).toBe(0.5);
    expect(summary.cost_partial).toBe(true);
  });
});

describe("summarizeUsage — records: tokens", () => {
  it("sums only input and output, never the subset categories", () => {
    const summary = summarizeUsage({
      tokens_usages: [
        record({
          nb_tokens_by_category: {
            input: 1000,
            input_cached: 800,
            output: 50,
            output_reasoning: 30,
          },
        }),
        record({ nb_tokens_by_category: { input: 200, output: 10, some_future_category: 7 } }),
      ],
      usage_assembly_error: null,
    });
    expect(summary.tokens).toEqual({ input: 1200, output: 60 });
  });

  it("reports a null total for a category no record reported", () => {
    const summary = summarizeUsage({
      tokens_usages: [
        record({ nb_tokens_by_category: { output: 12 } }),
        record({ nb_tokens_by_category: null }),
      ],
      usage_assembly_error: null,
    });
    expect(summary.tokens).toEqual({ input: null, output: 12 });
  });

  it("keeps a reported zero apart from an unreported count", () => {
    const summary = summarizeUsage({
      tokens_usages: [record({ nb_tokens_by_category: { input: 0, output: 0 } })],
      usage_assembly_error: null,
    });
    expect(summary.tokens).toEqual({ input: 0, output: 0 });
  });
});

describe("summarizeUsage — records: assembly error", () => {
  it("relays a non-null assembly error verbatim beside a list", () => {
    const summary = summarizeUsage({
      tokens_usages: [record()],
      usage_assembly_error: "partial event read",
    });
    expect(summary.state).toBe("records");
    expect(summary.assembly_error).toBe("partial event read");
  });
});

describe("summarizeUsage — by_pipe", () => {
  it("groups calls per pipe and gathers the unattributed ones under null", () => {
    const summary = summarizeUsage({
      tokens_usages: [
        record({
          pipe_code: "extract",
          cost: 0.1,
          nb_tokens_by_category: { input: 10, output: 1 },
        }),
        record({ pipe_code: null, cost: 0.2, nb_tokens_by_category: { input: 20, output: 2 } }),
        record({
          pipe_code: "extract",
          cost: 0.3,
          nb_tokens_by_category: { input: 30, output: 3 },
        }),
        record({ pipe_code: null, cost: null, nb_tokens_by_category: null }),
      ],
      usage_assembly_error: null,
    });
    expect(summary.by_pipe).toEqual([
      {
        pipe_code: "extract",
        total_cost_usd: 0.1 + 0.3,
        cost_partial: false,
        tokens: { input: 40, output: 4 },
        calls: 2,
      },
      {
        pipe_code: null,
        total_cost_usd: 0.2,
        cost_partial: true,
        tokens: { input: 20, output: 2 },
        calls: 2,
      },
    ]);
  });

  it("sorts by cost descending with unrated pipes after every priced one", () => {
    const summary = summarizeUsage({
      tokens_usages: [
        record({ pipe_code: "unrated", cost: null }),
        record({ pipe_code: "cheap", cost: 0.01 }),
        record({ pipe_code: "free", cost: 0 }),
        record({ pipe_code: "expensive", cost: 2 }),
      ],
      usage_assembly_error: null,
    });
    expect(summary.by_pipe.map((row) => row.pipe_code)).toEqual([
      "expensive",
      "cheap",
      "free",
      "unrated",
    ]);
    expect(summary.by_pipe.map((row) => row.total_cost_usd)).toEqual([2, 0.01, 0, null]);
  });

  it("breaks a cost tie on call count, then on pipe code with the unattributed group last", () => {
    const summary = summarizeUsage({
      tokens_usages: [
        record({ pipe_code: null, cost: 0.5 }),
        record({ pipe_code: "beta", cost: 0.5 }),
        record({ pipe_code: "alpha", cost: 0.5 }),
        record({ pipe_code: "busy", cost: 0.25 }),
        record({ pipe_code: "busy", cost: 0.25 }),
      ],
      usage_assembly_error: null,
    });
    expect(summary.by_pipe.map((row) => [row.pipe_code, row.calls])).toEqual([
      ["busy", 2],
      ["alpha", 1],
      ["beta", 1],
      [null, 1],
    ]);
  });

  it("orders unrated pipes among themselves by call count, then pipe code", () => {
    const summary = summarizeUsage({
      tokens_usages: [
        record({ pipe_code: "b", cost: null }),
        record({ pipe_code: "a", cost: null }),
        record({ pipe_code: "c", cost: null }),
        record({ pipe_code: "c", cost: null }),
      ],
      usage_assembly_error: null,
    });
    expect(summary.by_pipe.map((row) => row.pipe_code)).toEqual(["c", "a", "b"]);
    expect(summary.total_cost_usd).toBeNull();
  });
});

describe("summarizeUsage — pre-contract records", () => {
  it("counts a record with no cost and no pipe_code as unrated and unattributed", () => {
    // An artifact written before the usage contract: no `cost`, no flattened `pipe_code`, the
    // legacy `job_metadata` / `unit_costs` riding the index signature. The relics are not read.
    const legacy: TokensUsageRecord = {
      model_type: "llm",
      inference_model_name: "gpt-4o",
      job_metadata: { pipe_code: "legacy_pipe" },
      unit_costs: { input: 0.0000025, output: 0.00001 },
      nb_tokens_by_category: { input: 40, output: 8 },
    };
    const summary = summarizeUsage({
      tokens_usages: [legacy, record({ pipe_code: "summarize", cost: 0.02 })],
      usage_assembly_error: null,
    });
    expect(summary.state).toBe("records");
    expect(summary.total_cost_usd).toBe(0.02);
    expect(summary.cost_partial).toBe(true);
    expect(summary.tokens).toEqual({ input: 140, output: 28 });
    expect(summary.by_pipe).toEqual([
      {
        pipe_code: "summarize",
        total_cost_usd: 0.02,
        cost_partial: false,
        tokens: { input: 100, output: 20 },
        calls: 1,
      },
      {
        pipe_code: null,
        total_cost_usd: null,
        cost_partial: false,
        tokens: { input: 40, output: 8 },
        calls: 1,
      },
    ]);
  });

  it("tolerates a record carrying no field at all", () => {
    const summary = summarizeUsage({ tokens_usages: [{}], usage_assembly_error: null });
    expect(summary).toEqual<UsageSummary>({
      state: "records",
      total_cost_usd: null,
      cost_partial: false,
      tokens: { input: null, output: null },
      calls: 1,
      assembly_error: null,
      by_pipe: [
        {
          pipe_code: null,
          total_cost_usd: null,
          cost_partial: false,
          tokens: { input: null, output: null },
          calls: 1,
        },
      ],
    });
  });
});

describe("summarizeUsage — the whole RunResults", () => {
  it("takes a completed run's results as they come back, without mutating them", () => {
    const tokensUsages = [
      record({ pipe_code: "cheap", cost: 0.01 }),
      record({ pipe_code: "expensive", cost: 1 }),
    ];
    const results: RunResults = {
      pipeline_run_id: "run_1",
      main_stuff: { title: "t" },
      graph_spec: null,
      tokens_usages: tokensUsages,
      usage_assembly_error: null,
    };
    const snapshot = structuredClone(results);

    const summary = summarizeUsage(results);

    expect(summary.by_pipe.map((row) => row.pipe_code)).toEqual(["expensive", "cheap"]);
    expect(results).toEqual(snapshot);
    expect(results.tokens_usages).toBe(tokensUsages);
  });
});

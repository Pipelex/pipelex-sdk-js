/**
 * Tests for `resultsFromExecute` — the public lift from a blocking execute result onto `RunResults`.
 *
 * The blocking fallback's own path is covered in `client-lifecycle.test.ts`, through the client.
 * What this suite pins is the function a direct `execute()` caller reaches for: called on its own,
 * with no client and no network, it must produce the same `RunResults` the durable path hands back,
 * so `summarizeUsage` and the parity fields read the same whichever route ran.
 */

import { describe, it, expect } from "vitest";

import { PipelexExecuteResult, resultsFromExecute } from "../src/execute-result.js";
import { MissingMainStuffError } from "../src/errors.js";
import { summarizeUsage } from "../src/usage.js";
import type { DictRunResultExecute } from "../src/models.js";

const TOKENS_USAGES = [
  {
    model_type: "llm",
    inference_model_name: "test-model",
    inference_model_id: "test-model-2026-01-01",
    pipe_code: "test_domain.summarize",
    job_category: "llm_job",
    unit_job_id: "llm_gen_text",
    nb_tokens_by_category: { input: 100, output: 20 },
    cost: 0.01,
    started_at: "2026-09-22T10:00:01Z",
    completed_at: "2026-09-22T10:00:03Z",
  },
];

const PIPE_IO_ARTIFACTS = {
  pipe_io_contracts: {
    "x.greet": {
      inputs: {},
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: { type: "object", properties: { text: { type: "string" } } },
      },
    },
  },
  input_form: { "x.greet": { fields: [] } },
  output_form: { "x.greet": { field: { name: "text", kind: "prose", required: true } } },
};

/** A completed blocking response, as it arrives on the wire, with extension fields on `pipe_output`. */
function executeResult(pipeOutputExtensions: Record<string, unknown> = {}): PipelexExecuteResult {
  return new PipelexExecuteResult({
    pipeline_run_id: "run-x",
    main_stuff_name: "result",
    pipe_output: {
      pipeline_run_id: "run-x",
      working_memory: {
        root: { result: { concept: "native.Text", content: { text: "hello" } } },
        aliases: { main_stuff: "result" },
      },
      ...pipeOutputExtensions,
    },
  } as unknown as DictRunResultExecute);
}

describe("resultsFromExecute", () => {
  it("lifts every extension field off pipe_output onto its own field", () => {
    const results = resultsFromExecute(
      executeResult({
        tokens_usages: TOKENS_USAGES,
        usage_assembly_error: null,
        graph_spec: { meta: { mode: "live" }, nodes: [] },
        graph_assembly_error: null,
        pipe_io_artifacts: PIPE_IO_ARTIFACTS,
        pipe_io_artifacts_error: null,
      }),
    );

    // The same accessors the hosted path answers — the point of the lift.
    expect(results.pipeline_run_id).toBe("run-x");
    expect(results.main_stuff).toEqual({ text: "hello" });
    expect(results.tokens_usages).toEqual(TOKENS_USAGES);
    expect(results.usage_assembly_error).toBeNull();
    expect(results.graph_spec).toEqual({ meta: { mode: "live" }, nodes: [] });
    expect(results.graph_assembly_error).toBeNull();
    // The runner's one envelope unwrapped onto the hosted body's three siblings.
    expect(results.pipe_io_contracts).toEqual(PIPE_IO_ARTIFACTS.pipe_io_contracts);
    expect(results.input_form).toEqual(PIPE_IO_ARTIFACTS.input_form);
    expect(results.output_form).toEqual(PIPE_IO_ARTIFACTS.output_form);
    expect(results.pipe_io_artifacts_error).toBeNull();
  });

  it("carries the working memory and the runner's whole pipe_output", () => {
    const result = executeResult();

    const results = resultsFromExecute(result);

    // `working_memory` reads the same on both paths; `pipe_output` rides whole, blocking only,
    // and is the same object rather than a copy — nothing of the envelope is thrown away.
    expect(results.working_memory).toEqual(result.pipe_output.working_memory);
    expect(results.pipe_output).toBe(result.pipe_output);
  });

  it("sets every lifted field even when the runner carried none of them", () => {
    // An older runner, or one with usage and graph tracing off: absent keys read null, never throw.
    const results = resultsFromExecute(executeResult());

    expect(results.tokens_usages).toBeNull();
    expect(results.usage_assembly_error).toBeNull();
    expect(results.graph_spec).toBeNull();
    expect(results.graph_assembly_error).toBeNull();
    expect(results.pipe_io_contracts).toBeNull();
    expect(results.input_form).toBeNull();
    expect(results.output_form).toBeNull();
    expect(results.pipe_io_artifacts_error).toBeNull();
  });

  it("leaves the three artifacts null beside a null envelope's error", () => {
    const results = resultsFromExecute(
      executeResult({
        pipe_io_artifacts: null,
        pipe_io_artifacts_error: "failed to build the I/O artifacts for the run",
      }),
    );

    // The error is what separates a broken build from a run that described nothing.
    expect(results.pipe_io_contracts).toBeNull();
    expect(results.input_form).toBeNull();
    expect(results.output_form).toBeNull();
    expect(results.pipe_io_artifacts_error).toBe("failed to build the I/O artifacts for the run");
  });

  it("hands summarizeUsage a result it reads without a blocking-path branch", () => {
    // The reason the lift is public: a direct `execute()` caller reaches the run-results helpers
    // instead of re-reading the usage records off `pipe_output` and folding them by hand.
    const summary = summarizeUsage(
      resultsFromExecute(executeResult({ tokens_usages: TOKENS_USAGES })),
    );

    expect(summary.state).toBe("records");
    expect(summary.total_cost_usd).toBeCloseTo(0.01);
    expect(summary.tokens).toEqual({ input: 100, output: 20 });
  });

  it("throws MissingMainStuffError for a run with no locatable main stuff", () => {
    const orphaned = new PipelexExecuteResult({
      pipeline_run_id: "run-x",
      main_stuff_name: "absent_key",
      pipe_output: {
        pipeline_run_id: "run-x",
        working_memory: { root: {}, aliases: {} },
      },
    } as unknown as DictRunResultExecute);

    // The accessor's own contract, reached through the lift: no half-filled `RunResults`.
    expect(() => resultsFromExecute(orphaned)).toThrow(MissingMainStuffError);
  });
});

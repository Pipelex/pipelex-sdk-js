import type { InputForm, OutputForm, PipeIOContracts } from "mthds/protocol";

import { RunFailedError, RunTimeoutError } from "./errors.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import type { DictPipeOutput, DictWorkingMemory } from "./models.js";

/**
 * Run-lifecycle types + polling for the hosted polling surface (`/v1/runs/*`).
 *
 * Long method runs outlive the hosted gateway's ~30s synchronous cap, so the
 * SDK submits a run (`POST /v1/start`), then polls a self-healing endpoint by
 * bare `pipeline_run_id` until the run reaches a terminal state. All state lives behind
 * the id (DynamoDB + Temporal on the platform), so a caller can drop the poll
 * loop and resume later with just the id.
 *
 * Polling is NOT part of the MTHDS Protocol — it is a hosted-API extension. A
 * bare runner 404s these routes, which the client translates into
 * `RunLifecycleUnavailableError`.
 *
 * Wire contract mirrors the Pipelex Hosted API:
 *   POST /v1/start                           → RunResultStart   (start, 202)
 *   GET  /v1/runs/{pipeline_run_id}/status   → RunRead          (status, self-healing)
 *   GET  /v1/runs/{pipeline_run_id}/results  → 202 / 200 / 409  (results)
 */

// ── Status ──────────────────────────────────────────────────────────

/**
 * Hosted run lifecycle status. Mirrors `pipelex_shared.schemas.run.RunStatus`
 * — run states are a hosted-implementation concept; the protocol defines none
 * (the hosted store tracks states like `PENDING`). `STARTED` is deprecated
 * server-side but kept here for historical rows.
 */
export type RunStatus =
  | "PENDING"
  | "STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TERMINATED"
  | "TIMED_OUT";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
]);

/** A terminal status means the run is done and will not transition again. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Only `COMPLETED` has a result; every other terminal status is a failure. */
export function isSuccessRunStatus(status: RunStatus): boolean {
  return status === "COMPLETED";
}

// ── Responses ───────────────────────────────────────────────────────

/**
 * A run record — the BASE shape of the run-lifecycle read surface.
 *
 * Only the base fields are declared. An implementation may return more
 * (identity, workflow ids, storage URLs, anything else) — those are
 * server-specific response fields, never named in this SDK; the index
 * signature keeps them accessible, mirroring the request-side `extra`
 * passthrough.
 */
export interface RunPublic {
  pipeline_run_id: string;
  pipe_code?: string | null;
  status: RunStatus;
  created_at: string;
  finished_at?: string | null;
  /** Server-specific response fields (defined by the server you call). */
  [extension: string]: unknown;
}

/**
 * A run read through the self-healing path (`RunPublic` + `degraded`).
 * When `degraded` is true, Temporal was unreachable and `status` is the
 * last-known DB value, not a freshly-derived one — pair with
 * `retry_after_seconds` (parsed from the `Retry-After` header).
 */
export interface RunRead extends RunPublic {
  degraded: boolean;
  retry_after_seconds?: number | null;
}

/**
 * One inference call's token usage — the client-facing wire record.
 *
 * Mirrors the runtime's `TokensUsageRecord`. Inference accounting is a Pipelex runtime
 * extension — the MTHDS Protocol does not model it — so the hosted API is what pins this
 * wire contract. The same shape rides both surfaces: the durable `tokens_usages.json`
 * artifact that the hosted results route relays, and the blocking execute response's
 * `pipe_output.tokens_usages`.
 *
 * Every field is optional and the index signature is open **on purpose**. A record the
 * current runtime emits always carries the full key set (a field with no value is an
 * explicit `null`, never an omitted key), so callers may read any field directly. But
 * durable artifacts written before the contract shipped are relayed verbatim and never
 * migrated: such a record arrives with no `cost` and no `pipe_code`, and keeps its legacy
 * `job_metadata` / `unit_costs` — reachable through the index signature, never contract
 * fields.
 *
 * The enum-ish fields are open sets on the wire and stay `string` here — never frozen
 * unions — so runtime enum churn is non-breaking for consumers.
 */
export interface TokensUsageRecord {
  /** Kind of inference. Known values: `llm`, `img_gen`, `extract`, `search`. */
  model_type?: string | null;
  /** Human model name (e.g. `gpt-4o`). */
  inference_model_name?: string | null;
  /** Provider/platform model id (e.g. `gpt-4o-2024-11-20`). */
  inference_model_id?: string | null;
  /** The pipe that made the call — what makes per-pipe cost attribution possible. */
  pipe_code?: string | null;
  /** Known values: `llm_job`, `img_gen_job`, `extract_job`, `search_job`, `jinja2_job`, `mock_job`. */
  job_category?: string | null;
  /**
   * Known values: `llm_gen_text`, `llm_gen_object`, `img_gen_text_to_image`,
   * `extract_pages`, `search_sourced_answer`, `search_structured`.
   */
  unit_job_id?: string | null;
  /**
   * Raw provider-reported token counts, keyed by token category (`input`, `input_cached`,
   * `output`, `output_reasoning`, …). `input` is the joined total and `input_cached` a
   * subset of it — the categories are NOT additive, so summing them double-counts.
   */
  nb_tokens_by_category?: Record<string, number> | null;
  /**
   * Computed USD cost of this call. Null when the model has no rate table at all (own-GPU,
   * mock, dry run); `0` means a rate table existed and priced the call at zero. The
   * underlying rate table never crosses the wire and there is no run-level aggregate — sum
   * the records.
   */
  cost?: number | null;
  /** ISO 8601 start of the call. */
  started_at?: string | null;
  /** ISO 8601 end of the call. Duration is derivable from the pair and deliberately not shipped. */
  completed_at?: string | null;
  /** Legacy fields on a pre-contract artifact relayed verbatim (`job_metadata`, `unit_costs`). */
  [extension: string]: unknown;
}

/**
 * Result artifacts for a completed run — `GET /v1/runs/{pipeline_run_id}/results`.
 *
 * `main_stuff` is the resolved main output content and is ALWAYS present for a
 * completed run (the pipelex >= 0.37 main-stuff invariant): on the hosted path it
 * is the `main_stuff.json` S3 artifact relayed verbatim; on the bare-runner blocking
 * path the SDK resolves it from the returned working memory via the run's
 * `main_stuff_name`, so both paths deliver the same content shape. Consumers read
 * `main_stuff` directly — no shape-guessing. A completed run that cannot deliver a
 * main stuff throws `MissingMainStuffError`.
 */
export interface RunResults {
  pipeline_run_id: string;
  /**
   * The resolved main output content — always present for a completed run. Typed `unknown`
   * because the content is polymorphic: a structured output is an object of the concept's fields,
   * a multiple output the envelope `{ items: [...] }` the runtime's `ListContent` serialises to,
   * and a native is wrapped too (`{ text }`, `{ number }`). It may be a valid empty value — an
   * empty `items`, an empty `text` — but it is never absent. See `docs/run-results.md`.
   */
  main_stuff: unknown;
  /**
   * The run's working memory — every named stuff of the run (`{ root, aliases }`), the inputs it
   * was given and the intermediates it produced as well as the main output, each stuff carried as
   * its concept ref and its content. It reads the same on both paths: the hosted path relays the
   * `working_memory.json` artifact verbatim, and on the blocking path the SDK lifts it off
   * `pipe_output`. `main_stuff` is the content of one of its entries, already resolved. Null on the
   * hosted path when the artifact was not yet written. `DictWorkingMemory` mirrors the MTHDS
   * standard's `DictWorkingMemory` field for field. A run delivered by a runtime older than
   * pipelex 0.60.0 carries each `concept` as the concept object instead, and a stored artifact is
   * relayed as written, never migrated: the type stays the standard's `string`, so read `concept`
   * as `unknown` when a run may predate that release. See `docs/run-results.md`.
   */
  working_memory?: DictWorkingMemory | null;
  /**
   * The executed graph — the same document a local run writes as `graphspec.json`: `meta.mode`
   * `"live"`, one node per pipe with its status, its timings and its own usage. It reaches the client on both
   * paths: the hosted path relays the `graphspec.json` artifact verbatim, and on the blocking path
   * the SDK lifts it off `pipe_output`. Null when the runner assembled no graph (see
   * `graph_assembly_error`) or, on the hosted path, when the artifact was not yet written. Typed
   * `unknown` on purpose — the canonical declaration is `GraphSpec` in `@pipelex/mthds-ui`, which
   * carries a React peer dependency this server-side SDK does not take. See `docs/run-results.md`.
   */
  graph_spec?: unknown;
  /**
   * Non-null when the runner's graph assembly failed for the run — the graph's twin of
   * `usage_assembly_error`, and the only thing that separates "the graph broke" from "this run
   * produced no graph". Lifted off `pipe_output` on the blocking path; the hosted results body
   * carries nothing of the kind yet, so on that path the field is absent until the platform writes
   * and relays it.
   */
  graph_assembly_error?: string | null;
  /**
   * Per-pipe input/output contracts for the library the run executed against, keyed by
   * namespaced `pipe_ref` (`domain.code`) — the standard's `PipeIOContracts`, the same artifact
   * `POST /v1/validate` reports and the same one a local run writes beside its graph as
   * `pipe_io_contracts.json`. Imported from `mthds/protocol` rather than restated, under the
   * standing ruling that keeps the standard's artifacts declared once per language
   * (`docs/architecture.md`). It is what says what a `graph_spec` node's data IS: the graph
   * carries the values, this carries their concepts and their schemas.
   *
   * Read it together with `output_form` — `@pipelex/mthds-ui`'s `GraphViewer` takes the pair or
   * neither, and shows a node's structure table instead of its payload when one is missing.
   *
   * Null on the hosted path for a run whose artifacts were not written, and `undefined` until the
   * platform relays the key. See `docs/run-results.md`.
   */
  pipe_io_contracts?: PipeIOContracts | null;
  /**
   * Per-pipe input-form descriptors for that same library — the standard's `InputForm`, keyed
   * over the same `pipe_ref` set as `pipe_io_contracts`, describing each declared input as a
   * typed field rather than a schema. It is what lets a rendered run show its own inputs as
   * values; the renderer treats it as optional even when it has the other two.
   *
   * Null or absent on the same terms as `pipe_io_contracts`.
   */
  input_form?: InputForm | null;
  /**
   * Per-pipe OUTPUT-form descriptors for that same library — the standard's `OutputForm`, the
   * twin of `input_form` on the other side of the pipe, keyed over the same `pipe_ref` set. The
   * descriptor says what the result IS and the contract's `output.json_schema` names the property
   * its payload arrives under, which together are everything a renderer needs to lay a run's
   * result out without inspecting the value.
   *
   * Null or absent on the same terms as `pipe_io_contracts`.
   */
  output_form?: OutputForm | null;
  /**
   * Non-null when the runner's build of the three I/O artifacts failed for the run — their twin
   * of `graph_assembly_error`, and the only thing that separates "describing the data broke" from
   * "this run described none". Lifted off `pipe_output` on the blocking path; the hosted results
   * body carries nothing of the kind yet, so on that path the field is absent until the platform
   * writes and relays it.
   */
  pipe_io_artifacts_error?: string | null;
  /**
   * Bare runner's native pipe output, blocking-execute path only; absent on the hosted path, whose
   * results body carries no such key, so it reads `undefined` there. Supplementary: `main_stuff`,
   * `working_memory`, the graph pair and the usage pair are all lifted out of it onto their own
   * fields, which read the same on both paths. Read `working_memory` for the run's named stuffs;
   * `pipe_output` is the runner's output as it arrived, extension fields included.
   */
  pipe_output?: DictPipeOutput | null;
  /**
   * Per-call usage records — token counts by category, computed `cost` in USD, model id —
   * for LLM and img-gen/extract/search calls alike. On the hosted path this is the
   * `tokens_usages.json` artifact's record list relayed verbatim; on the blocking path it is
   * the execute response's `pipe_output.tokens_usages`. Null whenever assembly produced no
   * list — it was off, it broke (see `usage_assembly_error`), or (hosted) the run was
   * delivered before the artifact existed; `[]` when assembly ran and no inference happened.
   */
  tokens_usages?: TokensUsageRecord[] | null;
  /**
   * Non-null when the runner's usage assembly failed for the run. The ONLY field that
   * separates "usage broke" from "usage was off" / "pre-artifact run" — all three leave
   * `tokens_usages` null, so a caller that cares must branch on this, not on the list.
   */
  usage_assembly_error?: string | null;
}

/**
 * Single-shot result lookup outcome, discriminated on `state`:
 * - `running`  — HTTP 202; poll again after `retry_after_seconds`.
 * - `completed` — HTTP 200; `result` carries the artifacts.
 * - `failed`   — HTTP 409; run reached a terminal non-`COMPLETED` status.
 */
export type RunResultState =
  | { state: "running"; pipeline_run_id: string; retry_after_seconds: number | null }
  | { state: "completed"; pipeline_run_id: string; result: RunResults }
  | { state: "failed"; pipeline_run_id: string; status: RunStatus; message: string };

// ── Polling options ─────────────────────────────────────────────────

export interface WaitForResultOptions {
  /**
   * Base poll interval in ms (default 2000). The server's `Retry-After`
   * header overrides this when it asks for a longer wait.
   */
  intervalMs?: number;
  /**
   * Max ms to wait before throwing `RunTimeoutError` (default 1_200_000 — 20 min).
   * `Infinity` waits for as long as the run takes; `NaN` is a `RangeError`.
   */
  timeoutMs?: number;
  /** Abort the poll loop (Ctrl-C / agent walk-away). */
  signal?: AbortSignal;
  /** Invoked before each sleep so callers can drive a spinner / progress line. */
  onPoll?: (info: { attempt: number; elapsedMs: number }) => void;
}

// ── Poll loop ───────────────────────────────────────────────────────

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.

/** A single result lookup — the primitive the poll loop drives. */
export type FetchResultOnce = (
  runId: string,
  options?: { signal?: AbortSignal },
) => Promise<RunResultState>;

/**
 * Poll a single-shot result lookup (`fetchOnce`) until the run reaches a
 * terminal state. Returns the artifacts on `COMPLETED`, throws `RunFailedError`
 * on any other terminal status, and throws `RunTimeoutError` if `timeoutMs`
 * elapses first (the run keeps executing server-side — re-poll by id later).
 *
 * The single owner of the wait/poll/Retry-After/abort logic — `PipelexApiClient.waitForResult`
 * delegates here, so the behavior can never drift.
 */
export async function pollUntilResult(
  fetchOnce: FetchResultOnce,
  runId: string,
  options: WaitForResultOptions = {},
): Promise<RunResults> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  // A NaN would reach the sleep's timer as a 1 ms delay and poll in a tight loop.
  if (Number.isNaN(intervalMs) || Number.isNaN(timeoutMs)) {
    throw new RangeError(
      `"intervalMs" and "timeoutMs" must be numbers, got ${String(intervalMs)} and ` +
        `${String(timeoutMs)}.`,
    );
  }
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    throwIfAborted(options.signal);

    // Enforce the deadline BEFORE each lookup, so a poll is never issued past the
    // timeout (the previous wait is clamped to the deadline, so the next loop
    // would otherwise fire one extra fetch right at it).
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new RunTimeoutError(
        `Run ${runId} did not reach a terminal state within ${timeoutMs}ms.`,
        runId,
        timeoutMs,
      );
    }

    const state = await fetchOnce(runId, { signal: options.signal });

    if (state.state === "completed") {
      return state.result;
    }
    if (state.state === "failed") {
      throw new RunFailedError(state.message, runId, state.status);
    }

    attempt += 1;
    options.onPoll?.({ attempt, elapsedMs });

    const retryMs = state.retry_after_seconds != null ? state.retry_after_seconds * 1000 : 0;
    const waitMs = Math.min(Math.max(intervalMs, retryMs), timeoutMs - elapsedMs);
    await sleep(waitMs, options.signal);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The run poll was aborted.", "AbortError");
}

/** Sleep that resolves after `ms`, or rejects immediately if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    // Clamped, since a longer delay overflows the timer and would fire at once: a sleep
    // past the cap ends at the cap, and the loop simply polls again.
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.min(ms, MAX_TIMER_DELAY_MS),
    );
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

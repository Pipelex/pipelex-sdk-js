import { RunFailedError, RunTimeoutError } from "./errors.js";

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
   * because the content is polymorphic (a list output renders to a top-level array, a structured
   * output to an object) and may be a valid falsy value (empty array, `0`); it is never absent.
   */
  main_stuff: unknown;
  /** Method graph spec (`graphspec.json`); null if missing mid-write or on the bare-runner path. */
  graph_spec?: unknown;
  /**
   * Bare runner's native pipe output — the full working memory (`{ root, aliases }`),
   * blocking-execute path only; null on the hosted path. Supplementary to `main_stuff`,
   * which is already resolved out of it; kept for consumers that need the whole working memory.
   */
  pipe_output?: Record<string, unknown> | null;
  /**
   * Per-call usage records — token counts by category, `unit_costs` in $/1M, model id — for
   * LLM and img-gen/extract/search calls alike. On the hosted path this is the
   * `tokens_usages.json` artifact's record list relayed verbatim; on the blocking path it is
   * the execute response's `pipe_output.tokens_usages`. Null when usage assembly was off for
   * the run, or (hosted) when the run was delivered before the artifact existed.
   */
  tokens_usages?: Array<Record<string, unknown>> | null;
  /**
   * Non-null when the runner's usage assembly failed for the run — distinguishes "usage
   * broke" from "usage was off" (both leave `tokens_usages` null).
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
  /** Max ms to wait before throwing `RunTimeoutError` (default 1_200_000 — 20 min). */
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
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
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

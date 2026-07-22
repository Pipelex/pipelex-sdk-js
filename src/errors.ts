/**
 * Pipelex SDK errors — transport and run-lifecycle errors raised by
 * `PipelexApiClient`. All derive from the protocol-base `PipelineRequestError`
 * (re-exported from `mthds/protocol`), except `ClientAuthenticationError`.
 */

import { PipelineRequestError } from "mthds/protocol";
import type { ValidationErrorItem } from "./models.js";

export { PipelineRequestError };

export class ClientAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAuthenticationError";
  }
}

/**
 * Base class for every failure raised by input preparation (`uploadFile` /
 * `prepareInputs`). Catch this to handle any preparation failure; catch a
 * subclass to branch on the semantic category. All preparation failures are
 * raised BEFORE any run is created — a run never triggers a hidden upload.
 */
export class InputPreparationError extends PipelineRequestError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InputPreparationError";
  }
}

/**
 * A local asset could not be turned into bytes: a missing or unreadable path, or
 * a path string in a non-Node runtime (path strings are Node-only). `source` is
 * the offending path.
 */
export class InvalidLocalSourceError extends InputPreparationError {
  public readonly source: string;

  constructor(message: string, source: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidLocalSourceError";
    this.source = source;
  }
}

/**
 * The server refused the asset — most commonly a `413` past the service-defined
 * size cap. The SDK does not impose a client-side cap; it surfaces the server's
 * rejection. `filename` and `status` locate it.
 */
export class RejectedAssetError extends InputPreparationError {
  public readonly filename: string;
  public readonly status: number;

  constructor(message: string, filename: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RejectedAssetError";
    this.filename = filename;
    this.status = status;
  }
}

/**
 * The configured deployment does not support upload (no `/v1/upload` route, seen
 * as a `404`). Upload is a hosted Pipelex-product capability even though the SDK
 * can be pointed at other base URLs.
 */
export class UnsupportedUploadCapabilityError extends InputPreparationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnsupportedUploadCapabilityError";
  }
}

/** Upload was not authorized — a `401`/`403` from the upload route. */
export class UploadAuthenticationError extends InputPreparationError {
  public readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UploadAuthenticationError";
    this.status = status;
  }
}

/**
 * A network or server fault reaching the upload route — an unreachable host, a
 * `5xx`, or any other unexpected `upload()` failure. It carries no `status` field
 * of its own: when a `5xx` produced it, the response and its status are reachable
 * on the wrapped `ApiResponseError` via `cause`.
 */
export class UploadTransportError extends InputPreparationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UploadTransportError";
  }
}

/**
 * Thrown when the Pipelex API host cannot be reached at all (DNS failure,
 * connection refused, TLS handshake failure, request timeout). The HTTP
 * exchange never produced a response — distinguish from `ApiResponseError`,
 * which represents a non-2xx response that did come back.
 *
 * `code` is the underlying network error code when available
 * (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `ABORT_TIMEOUT`).
 */
export class ApiUnreachableError extends PipelineRequestError {
  public readonly apiUrl: string;
  public readonly code: string | undefined;

  constructor(
    message: string,
    apiUrl: string,
    code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiUnreachableError";
    this.apiUrl = apiUrl;
    this.code = code;
  }
}

/**
 * Thrown when the blocking `execute` (`POST /v1/execute`) is killed by the
 * hosted gateway's ~30s synchronous-request limit. The blocking path cannot
 * run methods longer than 30s behind the hosted gateway — use the durable run
 * lifecycle (start + poll) instead.
 */
export class PipelineExecuteTimeoutError extends PipelineRequestError {
  public readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: { cause?: unknown }) {
    const seconds = Math.round(elapsedMs / 1000);
    super(
      `The Pipelex Hosted API times out synchronous requests after ~30s — this run took ${seconds}s. ` +
        "The blocking execute path can't run methods longer than 30s behind the gateway. " +
        "Start the run and poll for its result instead: `start()` then `waitForResult(runId)`.",
      options,
    );
    this.name = "PipelineExecuteTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Thrown when a run reaches a terminal state that is not `COMPLETED`
 * (`FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`) — surfaced from
 * `waitForResult`/`getRunResult` when the server answers a result lookup with
 * HTTP 409. `runId` and `status` let callers report the outcome precisely.
 */
export class RunFailedError extends PipelineRequestError {
  public readonly runId: string;
  public readonly status: string;

  constructor(message: string, runId: string, status: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunFailedError";
    this.runId = runId;
    this.status = status;
  }
}

/**
 * Thrown when a completed run cannot deliver its main stuff.
 *
 * Every completed run delivers a main stuff (the pipelex >= 0.37 wire invariant), so the SDK
 * hands consumers a non-null `RunResults.main_stuff`. This surfaces the contract violation when it
 * cannot: the hosted results endpoint answered a `200` with a null `main_stuff`, or a blocking
 * `execute` response named a `main_stuff_name` whose stuff is absent from the returned working
 * memory. `runId` locates the run. (A falsy-but-present main stuff — an empty array, `0` — is a
 * valid output and does NOT throw; only a genuinely absent one does.)
 */
export class MissingMainStuffError extends PipelineRequestError {
  public readonly runId: string;

  constructor(message: string, runId: string) {
    super(message);
    this.name = "MissingMainStuffError";
    this.runId = runId;
  }
}

/**
 * Thrown when `waitForResult` exceeds its `timeoutMs` before the run reaches a
 * terminal state. The run is NOT cancelled — it keeps executing server-side and
 * can be resumed later by `runId` (the poll loop just stopped waiting).
 */
export class RunTimeoutError extends PipelineRequestError {
  public readonly runId: string;
  public readonly timeoutMs: number;

  constructor(message: string, runId: string, timeoutMs: number) {
    super(message);
    this.name = "RunTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when `execute()` receives a 202 instead of a final result.
 *
 * The MTHDS Protocol permits an implementation to degrade a synchronous
 * `/execute` into an accepted-async response (202 with a `Location` header)
 * when it cannot hold the connection open. The run keeps executing
 * server-side — resume by `runId` (`getRunResult` / `waitForResult` on a
 * hosted deployment, or the `location` status resource when provided).
 */
export class RunStillRunningError extends PipelineRequestError {
  public readonly runId: string;
  public readonly retryAfterSeconds: number | null;
  public readonly location: string | null;

  constructor(
    message: string,
    runId: string,
    retryAfterSeconds: number | null = null,
    location: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RunStillRunningError";
    this.runId = runId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.location = location;
  }
}

/**
 * Thrown when the durable run lifecycle (`/v1/runs/*`) is not served by the
 * configured `PIPELEX_BASE_URL`.
 *
 * Run polling is a hosted-API extension, not part of the MTHDS Protocol: the
 * open-source `pipelex-api` runner executes methods but has no run store, so
 * it 404s those routes; only a deployment that includes the platform block
 * (the Pipelex Hosted API) serves status/results. Distinguished from a genuine
 * run-not-found 404, which carries the server's structured error envelope.
 */
export class RunLifecycleUnavailableError extends PipelineRequestError {
  public readonly apiUrl: string;

  constructor(message: string, apiUrl: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunLifecycleUnavailableError";
    this.apiUrl = apiUrl;
  }
}

/**
 * A non-2xx response that DID come back from the API. Carries the parsed
 * RFC 7807 problem-details (`errorType`, `serverMessage`) and, for the build
 * routes' 422s, the structured `validation_errors[]` list.
 *
 * `code` is the product routes' stable RFC 9457 `problem+json` discriminant
 * (`conflict`, `not_found`, `pipelex_api_key_limit_reached`,
 * `promo_code_invalid`, …) — the field a consumer branches on, decoupled from
 * the HTTP status. `undefined` for any error body that carries no `code`
 * (the protocol/build routes' `detail`-shaped problems, auth, transport).
 */
export class ApiResponseError extends PipelineRequestError {
  public readonly apiUrl: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  public readonly errorType: string | undefined;
  public readonly serverMessage: string | undefined;
  public readonly code: string | undefined;
  /**
   * Structured per-error diagnostics on a problem body that carries a top-level
   * `validation_errors[]` — the **build routes** (`POST /v1/build/*`), which still
   * reject an invalid bundle with a 422.
   *
   * `POST /v1/validate` no longer routes content errors here: an invalid bundle is
   * a produced verdict (a **200** `PipelexInvalidReport` whose `validation_errors[]`
   * the caller reads off the returned value), not an `ApiResponseError`. This field
   * stays for the build-route 422s and is `undefined` for any error that carries no
   * per-error list (auth, transport, a request-shape 422). A consumer must NOT
   * assume a given `error_type` implies a populated list — fall back to
   * `serverMessage` when this is empty.
   */
  public readonly validationErrors: ValidationErrorItem[] | undefined;

  constructor(
    message: string,
    apiUrl: string,
    status: number,
    statusText: string,
    responseBody: string,
    errorType: string | undefined,
    serverMessage: string | undefined,
    validationErrors: ValidationErrorItem[] | undefined,
    code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiResponseError";
    this.apiUrl = apiUrl;
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.errorType = errorType;
    this.serverMessage = serverMessage;
    this.validationErrors = validationErrors;
    this.code = code;
  }
}

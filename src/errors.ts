/**
 * Pipelex SDK errors — transport and run-lifecycle errors raised by
 * `PipelexApiClient`. All derive from the protocol-base `PipelineRequestError`
 * (re-exported from `mthds/protocol`), except `ClientAuthenticationError`.
 */

import { PipelineRequestError } from "mthds/protocol";
import type { ValidationErrorItem } from "./models.js";
import type { ArtifactScope, DownloadArtifactsResult } from "./artifacts.js";

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
 * The stored method resolved by `getMethodClosure` has no MTHDS source yet — its
 * `MethodData.mthds` parses to an empty closure (a blank string, a JSON `[]`, or
 * an all-blank file array). `getMethodClosure` is the only raiser: the operations
 * that take a `method_id` natively — `prepareInputs` among them — pass the id to
 * the server, which answers a sourceless method with a `422`.
 *
 * Distinct from a transport failure: the `getMethod` fetch succeeded (`200`) and
 * the id is real and in-org; the row simply carries no runnable source. A missing
 * or foreign-org id is a `getMethod` `404` (`ApiResponseError` `not_found`), not
 * this. `methodId` locates the empty method.
 */
export class EmptyMethodSourceError extends InputPreparationError {
  public readonly methodId: string;

  constructor(methodId: string, options?: { cause?: unknown }) {
    super(`Method "${methodId}" has no MTHDS source yet.`, options);
    this.name = "EmptyMethodSourceError";
    this.methodId = methodId;
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
 * Why an asset was refused, in a closed vocabulary a caller branches on rather than
 * on the message: `too_large` — past the service-defined size cap (`uploadFile`'s
 * `413`); `grant_used` — the upload grant already wrote its object (`412`);
 * `grant_expired` — the grant's validity window has passed; `signature_mismatch` —
 * the file's size, content type or metadata differ from what the grant signed;
 * `unsigned_header` — the request carried a storage header the grant did not sign;
 * `store_refused` — any other refusal from storage.
 */
export type RejectedAssetCode =
  | "too_large"
  | "grant_used"
  | "grant_expired"
  | "signature_mismatch"
  | "unsigned_header"
  | "store_refused";

/**
 * The server or storage refused the asset — most commonly a `413` past the
 * service-defined size cap, or storage refusing an upload with a grant. The SDK
 * does not impose a client-side cap; it surfaces the refusal. `filename` and
 * `status` locate it, and `code` says why: the SDK sets it on every one it raises,
 * so it is undefined only on one a caller constructs without it.
 */
export class RejectedAssetError extends InputPreparationError {
  public readonly filename: string;
  public readonly status: number;
  public readonly code: RejectedAssetCode | undefined;

  constructor(
    message: string,
    filename: string,
    status: number,
    options?: { cause?: unknown; code?: RejectedAssetCode },
  ) {
    super(message, options);
    this.name = "RejectedAssetError";
    this.filename = filename;
    this.status = status;
    this.code = options?.code;
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
 * A network or server fault reaching the upload route or storage — an unreachable
 * host, a `5xx`, a refused redirect, storage timing out on the body, or any other
 * unexpected `upload()` failure. `status` is the HTTP status when a response
 * produced it, and undefined when none did. From `uploadFile` the wrapped
 * `ApiResponseError` is also reachable via `cause`; `uploadWithGrant` wraps no
 * response, because storage's error body can echo the grant's credential.
 */
export class UploadTransportError extends InputPreparationError {
  public readonly status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "UploadTransportError";
    this.status = options?.status;
  }
}

/**
 * Base class for the failures the artifact operations raise on their own
 * (`fetchArtifact` / `downloadArtifacts`) — the download twin of
 * `InputPreparationError`. Catch this to handle any artifact failure; catch a
 * subclass to branch on the category. A per-reference failure inside a
 * `downloadArtifacts` verdict is a value on the item, never one of these: the
 * operation throws only when it can produce no verdict at all. Transport
 * failures on the resolve route (`ApiResponseError`, `ApiUnreachableError`)
 * and the run-lifecycle errors propagate unchanged, so they are not subclasses.
 */
export class ArtifactOperationError extends PipelineRequestError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArtifactOperationError";
  }
}

/**
 * The scope `downloadArtifacts` was asked to walk has no artifact on the run's
 * results: `main_stuff` or `working_memory` is `null`, or the key is missing
 * from the body altogether. Distinct from an empty walk over a present scope,
 * which is a produced verdict with no artifacts. `scope` names the scope,
 * `runId` the run.
 */
export class ScopeUnavailableError extends ArtifactOperationError {
  public readonly scope: ArtifactScope;
  public readonly runId: string;

  constructor(scope: ArtifactScope, runId: string, options?: { cause?: unknown }) {
    super(
      `Run "${runId}" carries no "${scope}" artifact to walk for produced files — ` +
        "it is null or absent from the results body.",
      options,
    );
    this.name = "ScopeUnavailableError";
    this.scope = scope;
    this.runId = runId;
  }
}

/**
 * One reference could not be turned into a bounded response by `fetchArtifact`.
 * `code` says why, in a closed vocabulary the download verdict shares for its
 * per-item errors: the resolve route's own per-reference codes
 * (`invalid_storage_uri`, `forbidden`), then the fetch boundary's —
 * `unsupported_url`, `plain_http_refused`, `redirect_refused`, `store_refused`
 * (a 401/403 from the object store), `not_found` (404/410), `store_error`
 * (any other non-2xx), `too_large`, `timeout`, `network`. `status` is the
 * store's HTTP status when one was received. `downloadArtifacts` never lets
 * this escape: it becomes the item's `error`.
 */
export class ArtifactFetchError extends ArtifactOperationError {
  public readonly uri: string;
  public readonly code: string;
  public readonly status: number | undefined;

  constructor(
    message: string,
    uri: string,
    code: string,
    status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ArtifactFetchError";
    this.uri = uri;
    this.code = code;
    this.status = status;
  }
}

/**
 * The resolve route refused the caller's credential (`401` / `403`) during a
 * `downloadArtifacts` call. No further reference can be resolved with it, so
 * the download stops — but the files already saved are real, and `verdict`
 * carries the result as it stood: every item saved before the refusal, and
 * the rest marked `aborted`. `status` is the route's status; the wrapped
 * `ApiResponseError` is reachable via `cause`.
 */
export class ArtifactAuthenticationError extends ArtifactOperationError {
  public readonly status: number;
  public readonly verdict: DownloadArtifactsResult;

  constructor(
    message: string,
    status: number,
    verdict: DownloadArtifactsResult,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ArtifactAuthenticationError";
    this.status = status;
    this.verdict = verdict;
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
 * memory. `runId` locates the run. (An empty-but-present main stuff — `{ items: [] }`, `{ text:
 * "" }` — is a valid output and does NOT throw; only a genuinely absent one does.)
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

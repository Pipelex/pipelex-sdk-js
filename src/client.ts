import type {
  MTHDSProtocol,
  ModelCategory,
  ModelDeck,
  RunOptions,
  RunRequest,
  RunResultStart,
  StartOptions,
  StartRequest,
  VersionInfo,
} from "mthds/protocol";
import type {
  BuildInputsRequest,
  BuildInputsResponse,
  BuildOutputRequest,
  BuildOutputResponse,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ConceptRequest,
  ConceptResponse,
  DictPipeOutput,
  DictRunResultExecute,
  FormatResponse,
  LintResponse,
  PipeSpecRequest,
  PipeSpecResponse,
  PipelexValidationResult,
  ValidationErrorItem,
} from "./models.js";
import {
  pollUntilResult,
  type RunRead,
  type RunResults,
  type RunResultState,
  type RunStatus,
  type WaitForResultOptions,
} from "./runs.js";
import type {
  BillingPortalResponse,
  ChangePlanResponse,
  CheckoutResponse,
  GatewayApiKey,
  GatewayApiKeyStatus,
  InvoiceView,
  Membership,
  MembershipsResponse,
  MethodData,
  MethodWriteInput,
  OnboardingSubmission,
  PipelexApiKeyCreated,
  PipelexApiKeyList,
  PipelineRun,
  PlanView,
  ResolvedStorageUrl,
  SubscriptionResponse,
  UpdateRunInput,
  UploadInput,
  UploadedFile,
  UserProfile,
} from "./product-models.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
} from "./errors.js";
import { uploadFile as uploadFileImpl } from "./upload.js";
import type { UploadableAsset, UploadFileOptions, UploadRecord } from "./upload.js";
import { prepareInputs as prepareInputsImpl } from "./prepare-inputs.js";
import type { PrepareInputsRequest, PreparedInputs } from "./prepare-inputs.js";
import { PipelexExecuteResult } from "./execute-result.js";

export interface MthdsFile {
  /** File contents to validate. */
  content: string;
  /** Optional provenance URI threaded into validation diagnostics. */
  uri?: string;
}

export interface ValidateFilesOptions {
  /** Whether unresolved pipe signatures are accepted as pending instead of invalid. */
  allowSignatures?: boolean;
  /** Optional validate presentation hints, e.g. ["markdown"]. */
  render?: string[];
  /** Per-call request ceiling; defaults to the 20-min execute ceiling. */
  timeoutMs?: number;
  /** Caller-driven cancellation; the abort reason propagates untouched. */
  signal?: AbortSignal;
}

export interface PipelexApiClientOptions {
  /** API key (Bearer). Falls back to `PIPELEX_API_KEY`. Optional for anonymous bare runners. */
  apiKey?: string;
  /**
   * API base URL — host only, NO version prefix (e.g. `https://api.pipelex.com`
   * or `http://localhost:8081`). Every endpoint composes as
   * `{baseUrl}/v1/{endpoint}`. Falls back to `PIPELEX_BASE_URL`, then the hosted
   * default.
   */
  baseUrl?: string;
}

/** Low-level transport over a generic fetch, before status interpretation. */
interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

/** HTTP methods the client issues — the product routes add PUT/PATCH/DELETE. */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Hosted default — the client composes every endpoint as `{base}/v1/{endpoint}`. */
export const DEFAULT_API_BASE_URL = "https://api.pipelex.com";

// The client composes every endpoint from one origin (PIPELEX_BASE_URL): `{base}/v1/{endpoint}`.
// The same paths are served by the Pipelex Hosted API (api.pipelex.com) and by a bare
// OSS pipelex-api runner (localhost:8081) — the protocol surface is identical; only
// the hosted extensions (e.g. run polling) differ, detectable via GET /v1/version.
const API_PREFIX = "v1";
const RUNS = "runs";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single status/result GETs; the hosted gateway caps responses at ~30s.
// `build/runner` is the one extension route that dry-run-sweeps the closure, and it
// sweeps the WHOLE closure when `pipe_ref` is omitted. The 30s management timeout is
// sized for the static routes; a large closure legitimately exceeds it, and aborting
// it would surface as `ApiUnreachableError` — blaming the network for a healthy server.
const BUILD_RUNNER_TIMEOUT_MS = 300_000; // 5 min
const DEFAULT_DEGRADED_RETRY_SECONDS = 5; // matches the platform's `_DEGRADE_RETRY_AFTER_SECONDS`.
const VALIDATE_MARKDOWN_RENDER_FORMAT = "markdown";

/**
 * `VersionInfo.implementation` of the bare open-source runner (no run store).
 * Anything else — the hosted `pipelex-hosted` first — is assumed to serve the
 * durable run-lifecycle extension; a wrong guess still fails with the clear
 * `RunLifecycleUnavailableError` on the first poll.
 */
const BARE_RUNNER_IMPLEMENTATION = "pipelex-api";

/**
 * Client for the Pipelex hosted API — and any MTHDS-compliant runner.
 *
 * One base URL (`PIPELEX_BASE_URL`); every endpoint is `<base>/v1/<endpoint>`:
 * - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — works
 *   against any MTHDS-compliant runner, hosted or bare.
 * - **build extensions** (`/v1/build/*`) — the Pipelex API's authoring helpers.
 * - **tools extensions** (`lint` / `format`) — single-file static diagnostics and
 *   canonical formatting, served by any pipelex-api runner.
 * - **run lifecycle** (`getRunStatus` / `getRunResult` / `waitForResult`) — the
 *   durable polling extension that survives long runs and lets a caller resume by
 *   id. Served only by a deployment that includes the platform block (the Pipelex
 *   Hosted API); a bare `pipelex-api` runner 404s those routes, which the lifecycle
 *   methods translate into a clear `RunLifecycleUnavailableError`.
 *
 * Implements `MTHDSProtocol<DictPipeOutput>` so the protocol-execution methods
 * stay shaped like the standard's wire surface (`mthds/protocol`). The Pipelex
 * extensions (build, run lifecycle) ride on top.
 */
export class PipelexApiClient implements MTHDSProtocol<DictPipeOutput> {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;
  /** Cached `/v1/version` handshake outcome — whether the durable lifecycle is served. */
  private lifecycleAvailable: boolean | undefined;

  constructor(options: PipelexApiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PIPELEX_API_KEY;
    const normalizedBaseUrl = (
      options.baseUrl ??
      process.env.PIPELEX_BASE_URL ??
      DEFAULT_API_BASE_URL
    ).replace(/\/+$/, "");
    // The base URL must be host-only: direct SDK usage and PIPELEX_BASE_URL reach
    // this constructor and must be held to that rule, or a path-prefixed value
    // (e.g. `.../v1`) composes as `/v1/v1/...` and fails with a misleading
    // endpoint error instead of a clear base-URL one. Trailing slashes are
    // stripped first; a remaining path/query/fragment/credentials is rejected.
    if (!isValidBaseUrl(normalizedBaseUrl)) {
      throw new PipelineRequestError(
        `Invalid API base URL "${normalizedBaseUrl}": must be host-only ` +
          `(http/https, no path, query, fragment, or credentials). Endpoints ` +
          `compose as {base}/v1/{endpoint}.`,
      );
    }
    this.baseUrl = normalizedBaseUrl;
    this.originUrl = new URL("/", this.baseUrl).origin;
  }

  // ── URL resolution ───────────────────────────────────────────────────

  /** Build an API URL: `<base>/v1/<endpoint>`. */
  private url(endpoint: string): string {
    return `${this.baseUrl}/${API_PREFIX}/${endpoint.replace(/^\/+/, "")}`;
  }

  // ── Transport ──────────────────────────────────────────────────────

  /**
   * Issue one HTTP request and return the raw status/headers/body. Wraps
   * DNS/connect/TLS/timeout failures as `ApiUnreachableError`; a caller-driven
   * abort (Ctrl-C / agent walk-away) propagates as-is so the poll loop can stop
   * cleanly. Non-2xx interpretation is left to the caller. `url` is a fully
   * resolved absolute URL.
   */
  private async requestRaw(
    method: HttpMethod,
    url: string,
    options: {
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const hasBody = options.body !== undefined;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
      timeoutMs,
    );
    const userSignal = options.signal;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }

    let response: Response;
    let body: string;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      // The body streams after the headers; keep the timer/abort armed until it
      // has fully arrived, or a stalled body would hang past the advertised
      // timeout with no way to cancel.
      body = await response.text();
    } catch (err) {
      // A caller-initiated abort (not our timeout) propagates untouched so
      // `waitForResult` callers can distinguish "I stopped waiting" from a
      // network failure.
      if (userSignal?.aborted) throw err;
      // undici (Node fetch) wraps DNS/connect/TLS failures as
      // `TypeError("fetch failed")` with the system error attached as `cause`.
      // Our timeout aborts the controller with a "TimeoutError" DOMException.
      const code = extractNetworkErrorCode(err);
      throw new ApiUnreachableError(
        `Could not reach Pipelex API at ${this.baseUrl} (${code ?? "network error"})`,
        this.baseUrl,
        code,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    };
  }

  /**
   * Issue a request and parse the JSON body, throwing a plain `Error` on a non-2xx
   * response. Used only by `health` — the origin-level liveness probe, which sits
   * outside `/v1` and outside the RFC 7807 error taxonomy the `/v1` routes share.
   * Every `/v1` route goes through a helper that maps its problem body to the typed
   * `ApiResponseError` instead.
   */
  private async requestJson<T>(method: HttpMethod, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${method} ${url} failed (${res.status}): ${text || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Issue a Pipelex-product request (`/v1/me`, `/v1/methods`, `/v1/billing/*`,
   * …) and parse its JSON body, mapping a non-2xx response to the typed
   * `ApiResponseError` so callers branch on the structured `code` discriminant,
   * not the HTTP status. Empty-body tolerant — DELETE / onboarding / updateRun
   * answer 2xx with no body, returned as `undefined`. Uses the management-call
   * timeout, not the blocking-execute ceiling.
   */
  private async requestProduct<T>(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.requestRaw(method, this.url(endpoint), {
      body,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError(method, endpoint, res);
    }
    return (res.body ? JSON.parse(res.body) : undefined) as T;
  }

  private throwApiResponseError(method: HttpMethod, endpoint: string, res: RawResponse): never {
    const { errorType, serverMessage, validationErrors, code } = parseErrorBody(res.body);
    throw new ApiResponseError(
      `API ${method} /${API_PREFIX}/${endpoint} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      this.baseUrl,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage,
      validationErrors,
      code,
    );
  }

  /**
   * Translate a "route absent" 404 (a bare pipelex-api with no platform block)
   * into a clear `RunLifecycleUnavailableError`. The platform's own 404s (run
   * not found / cross-org) carry a structured error envelope (a `code` field)
   * and are left for normal handling.
   */
  private throwIfLifecycleUnavailable(res: RawResponse, url: string): void {
    if (res.status !== 404) return;
    if (!isMissingRoute404(res.body)) return;
    throw new RunLifecycleUnavailableError(
      `The durable run lifecycle is not available: ${url} returned 404. Run polling is a ` +
        `hosted-API extension (/${API_PREFIX}/${RUNS}/*), not part of the MTHDS Protocol; ` +
        "PIPELEX_BASE_URL points at a bare runner that does not serve it.",
      this.baseUrl,
    );
  }

  /**
   * Map the protocol's optional 202 execute degrade to a typed
   * error. Hosted does not emit 202 today, but the protocol permits it;
   * raising a typed error (with the `pipeline_run_id` + `Location` + `Retry-After`
   * hints) beats a generic parse failure on an unexpected body shape.
   */
  private throwIfExecuteDegraded(res: RawResponse): void {
    if (res.status !== 202) return;
    let runId = "";
    try {
      const parsed: unknown = JSON.parse(res.body);
      if (parsed && typeof parsed === "object") {
        const candidate = (parsed as { pipeline_run_id?: unknown }).pipeline_run_id;
        if (typeof candidate === "string") runId = candidate;
      }
    } catch {
      // Non-JSON 202 body — keep runId empty; the error message covers it.
    }
    throw new RunStillRunningError(
      `execute() was accepted asynchronously (202): run ${runId || "<unknown>"} is still ` +
        "running server-side. Poll its results (hosted) or use start().",
      runId,
      parseRetryAfter(res.headers),
      res.headers.get("location"),
    );
  }

  // ── Health ────────────────────────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    // `/health` is origin-level, NOT under the `/v1` prefix.
    return this.requestJson("GET", `${this.originUrl}/health`);
  }

  // ── Protocol surface ─────────────────────────────────────────────────

  /**
   * Execute a method synchronously and wait for its completion —
   * `POST /v1/execute`.
   *
   * Returns a `PipelexExecuteResult` — the protocol's raw execute response enriched with a
   * resolved `.main_stuff` accessor, so a blocking result reads its output the same way as a
   * durable one (`result.main_stuff`) instead of digging through `pipe_output`.
   *
   * Behind the hosted gateway, synchronous requests terminate at ~30s; a run
   * that exceeds that surfaces as `PipelineExecuteTimeoutError` pointing at the
   * durable start+poll path. Throws `RunStillRunningError` on the protocol's
   * optional 202 degrade.
   */
  async execute(options: RunOptions): Promise<PipelexExecuteResult> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64) or a server-specific extension arg (extra) must be provided to execute().",
      );
    }
    assertExclusiveRunSources(options);

    const request: RunRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...extensions,
    };

    const startedAt = Date.now();
    try {
      const res = await this.requestRaw("POST", this.url("execute"), {
        body: request,
      });
      this.throwIfExecuteDegraded(res);
      if (res.status < 200 || res.status >= 300) {
        this.throwApiResponseError("POST", "execute", res);
      }
      // Wrap the base result in the enriched subtype (adds the `.main_stuff` accessor; the
      // `main_stuff_name` extension + working memory ride `pipe_output`).
      return new PipelexExecuteResult(JSON.parse(res.body) as DictRunResultExecute);
    } catch (err) {
      if (err instanceof RunStillRunningError) throw err;
      // The hosted gateway terminates synchronous requests at ~30s. A run that
      // exceeds that comes back as a gateway 503/504 (or a client abort) —
      // translate it into a clear, actionable error pointing at start+poll.
      const elapsedMs = Date.now() - startedAt;
      if (isGatewayTimeout(err, elapsedMs)) {
        throw new PipelineExecuteTimeoutError(elapsedMs, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Start a method asynchronously — `POST /v1/start` (202, no output yet).
   *
   * Server-specific extension args ride `options.extra` and merge into the
   * request body — the server you call defines and handles them (including a
   * client-supplied run id where a server supports one). The returned
   * `pipeline_run_id` is always authoritative; on a hosted deployment it is
   * durable — poll `getRunStatus` / `getRunResult`.
   */
  async start(options: StartOptions): Promise<RunResultStart> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64) or a server-specific extension arg (extra) must be provided to start().",
      );
    }
    assertExclusiveRunSources(options);

    // `?? undefined` so JSON.stringify drops absent fields from the wire body.
    const request: StartRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...extensions,
    };

    const url = this.url("start");
    const res = await this.requestRaw("POST", url, {
      body: request,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    // A bare runner with no run store 404s here just as it does on the result
    // routes — surface the same clear `RunLifecycleUnavailableError` (and let
    // `startAndWaitForResult` fall back to the blocking `execute`).
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "start", res);
    }
    return JSON.parse(res.body) as RunResultStart;
  }

  /**
   * Parse, validate, and dry-run an MTHDS bundle — `POST /v1/validate`.
   *
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the `PipelexValidationResult` union
   * verbatim — `is_valid: true` ⇒ the typed `PipelexValidationReport` (structural
   * artifacts), `is_valid: false` ⇒ a `PipelexInvalidReport` (`validation_errors[]`).
   * An invalid bundle is NOT thrown — the caller pattern-matches `is_valid`. Only a
   * *no-verdict* condition (a malformed request, an `mthds_sources` length mismatch,
   * auth, a server fault) is non-2xx and surfaces as `ApiResponseError`.
   *
   * `mthdsSources` (optional, parallel to `mthdsContents`) names each submitted
   * content — a Pipelex-API extension threaded onto `blueprint.source`, so
   * cross-file diagnostics name the owning file (an unnamed content yields
   * `source: null`). The server 422s a length mismatch; this client sends the
   * arrays verbatim and surfaces that as an `ApiResponseError`.
   *
   * `render` is the Pipelex-API presentation hint — a list of view-format tokens.
   * This client always asks for Markdown so both valid results and produced
   * validation-error verdicts carry `rendered_markdown`; callers may add more
   * tokens. Unknown tokens are server-side lenient-ignored (never a 422).
   */
  async validate(
    mthdsContents: string[],
    allowSignatures = false,
    mthdsSources?: string[],
    render?: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PipelexValidationResult> {
    const body: Record<string, unknown> = {
      mthds_contents: mthdsContents,
      allow_signatures: allowSignatures,
    };
    if (mthdsSources !== undefined) {
      body.mthds_sources = mthdsSources;
    }
    body.render = withValidateMarkdownRender(render);
    const res = await this.requestRaw("POST", this.url("validate"), {
      body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "validate", res);
    }
    return JSON.parse(res.body) as PipelexValidationResult;
  }

  /**
   * Validate paired MTHDS files while preserving URI attribution for diagnostics.
   *
   * This adapter intentionally keeps the low-level `validate(...)` payload shape
   * intact for existing consumers. When any file has a URI, every content gets a
   * parallel source label; inline labels are deterministic so the server never
   * sees a length-mismatched `mthds_sources` array.
   */
  async validateFiles(
    files: MthdsFile[],
    options: ValidateFilesOptions = {},
  ): Promise<PipelexValidationResult> {
    if (files.length === 0) {
      throw new PipelineRequestError(
        "At least one MTHDS file must be provided to validateFiles().",
      );
    }

    const mthdsContents = files.map((file) => file.content);
    const hasAnyUri = files.some((file) => file.uri !== undefined);
    const mthdsSources = hasAnyUri
      ? files.map((file, index) => file.uri ?? `inline://file-${index + 1}.mthds`)
      : undefined;

    return this.validate(
      mthdsContents,
      options.allowSignatures ?? false,
      mthdsSources,
      options.render,
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
    );
  }

  // ── Tools extensions (Pipelex API — `/v1/lint`, `/v1/format`) ─────────

  /**
   * Lint one `.mthds` file against the embedded MTHDS schema — `POST /v1/lint`.
   *
   * A diagnostic endpoint, like `validate`: malformed content is a produced verdict
   * on a 200 carrying `diagnostics[]` (empty when the file is clean), never a thrown
   * error. Only a no-verdict condition (a malformed request, auth, a server fault) is
   * non-2xx and surfaces as `ApiResponseError`.
   *
   * `source` is an optional logical filename accepted for parity with the local
   * tooling; today's diagnostics do not echo it back.
   *
   * Unlike `validate`, this is a static single-file check — no bundle load, no
   * dry-run, no cross-file resolution. Use `validate` for the full verdict.
   */
  async lint(content: string, source?: string): Promise<LintResponse> {
    const body: Record<string, unknown> = { content };
    if (source !== undefined) {
      body.source = source;
    }
    return this.requestExtension("lint", body);
  }

  /**
   * Format one `.mthds` file with the canonical MTHDS formatter — `POST /v1/format`.
   *
   * Returns the formatted content, a `changed` flag, and any `diagnostics[]`. A syntax
   * error is a produced verdict on a 200: the content comes back unchanged
   * (`changed: false`) with the diagnostics that explain why. Malformed formatter
   * `options` (e.g. a non-numeric `column_width`) ARE caller input errors and surface as
   * a 422 `ApiResponseError`.
   *
   * `options` passes formatter settings (e.g. `{ column_width: 100 }`) straight through
   * to the server-side formatter.
   */
  async format(content: string, options?: Record<string, unknown>): Promise<FormatResponse> {
    const body: Record<string, unknown> = { content };
    if (options !== undefined) {
      body.options = options;
    }
    return this.requestExtension("format", body);
  }

  /**
   * POST one of the Pipelex-API extension routes — the tools (`lint`, `format`) and
   * the build projections (`build/*`). Their non-2xx bodies are RFC 7807 problems,
   * mapped to the typed `ApiResponseError` like the product routes.
   *
   * The mapping is what makes their no-verdict arms usable: a build route answers
   * `422` for an unresolvable pipe selector (unknown `pipe_ref`; or an omitted one
   * on a closure declaring no `main_pipe`, or several) and `501` for the reserved
   * `method_ref`. A caller branches on `ApiResponseError.status`, never on a message.
   *
   * All of these are inference-free, so they default to the management-call timeout.
   * `build/runner` is the exception — it dry-run-sweeps the closure — and overrides it
   * via `timeoutMs`.
   */
  private async requestExtension<T>(
    endpoint: string,
    body: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.requestRaw("POST", this.url(endpoint), {
      body,
      timeoutMs: options.timeoutMs ?? POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", endpoint, res);
    }
    return JSON.parse(res.body) as T;
  }

  /** The model deck the runner can route to — `GET /v1/models[?type=]`. */
  async models(category?: ModelCategory): Promise<ModelDeck> {
    const endpoint = category ? `models?type=${encodeURIComponent(category)}` : "models";
    const res = await this.requestRaw("GET", this.url(endpoint), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    return JSON.parse(res.body) as ModelDeck;
  }

  /**
   * Protocol + implementation versions — `GET /v1/version` (always public).
   * The handshake for feature detection (hosted extensions or not).
   */
  async version(): Promise<VersionInfo> {
    const res = await this.requestRaw("GET", this.url("version"), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", "version", res);
    }
    return JSON.parse(res.body) as VersionInfo;
  }

  // ── Build extensions (Pipelex API layer 2 — `/v1/build/*`) ────────

  /**
   * Project a pipe's declared inputs as a fill-in template — `POST /v1/build/inputs`.
   *
   * Supply the closure as `files` (each `{content, source?}`) and, optionally, the
   * QUALIFIED `pipe_ref` to project; omitting it defaults to the closure's
   * `main_pipe`. The template rides `inputs` (a parsed object) for `format: "json"`,
   * the default, and `inputs_toml` (raw text) for `format: "toml"`.
   *
   * Returns a **200 verdict**: pattern-match `is_valid` before reading the arm — an
   * unresolvable closure comes back as `is_valid: false` with `validation_errors[]`,
   * not as a thrown error.
   */
  async buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse> {
    return this.requestExtension("build/inputs", request);
  }

  /**
   * Project a pipe's output concept — `POST /v1/build/output`. Same envelope and
   * same 200-verdict discipline as {@link buildInputs}. `format: "schema"` (the
   * default) and `"json"` put a parsed object in `output`; `"python"` puts source
   * text in `output_python`.
   */
  async buildOutput(request: BuildOutputRequest): Promise<BuildOutputResponse> {
    return this.requestExtension("build/output", request);
  }

  /**
   * Generate a runnable Python script plus its stamped typed structures —
   * `POST /v1/build/runner`. Same envelope and same 200-verdict discipline as
   * {@link buildInputs}.
   *
   * Alone among the build routes this one dry-runs the closure, so it also takes
   * `allow_signatures` (accept unresolved pipe signatures as pending). Note that
   * omitting `pipe_ref` sweeps the WHOLE closure rather than just the defaulted
   * pipe — the default can only be resolved after the sweep has run — so a broken
   * sibling pipe can sink the request. Pass `pipe_ref` to scope the sweep.
   *
   * Because of that sweep it is the one extension route that can legitimately run
   * long, so it gets its own generous timeout (5 min) rather than the 30s the static
   * routes use. Override it per call with `options.timeoutMs`; a caller that stops
   * caring mid-sweep can cancel via `options.signal` instead of waiting it out.
   */
  async buildRunner(
    request: BuildRunnerRequest,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BuildRunnerResponse> {
    return this.requestExtension("build/runner", request, {
      timeoutMs: options.timeoutMs ?? BUILD_RUNNER_TIMEOUT_MS,
      signal: options.signal,
    });
  }

  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    return this.requestExtension("build/concept", request);
  }

  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    return this.requestExtension("build/pipe-spec", request);
  }

  // ── Hosted extension: durable run lifecycle (NOT part of the protocol) ──

  /**
   * Fetch a run's status by bare id — `GET /v1/runs/{pipeline_run_id}/status`.
   *
   * Self-healing: a finished-but-unrecorded run resolves to its true terminal
   * status on read. `degraded: true` means Temporal was unreachable and
   * `status` is the last-known value; `retry_after_seconds` carries the
   * server's backoff hint when present. Throws `RunLifecycleUnavailableError`
   * when the lifecycle routes are absent (a bare runner).
   */
  async getRunStatus(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunRead> {
    const endpoint = `${RUNS}/${encodeURIComponent(runId)}/status`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const run = JSON.parse(res.body) as RunRead;
    const retryAfter = parseRetryAfter(res.headers);
    return retryAfter !== null ? { ...run, retry_after_seconds: retryAfter } : run;
  }

  /**
   * Single-shot result lookup — `GET /v1/runs/{pipeline_run_id}/results`.
   * Maps the server's poll semantics to a discriminated union:
   * - HTTP 202 → `running` (with the `Retry-After` hint)
   * - HTTP 200 → `completed` (with the result artifacts)
   * - HTTP 409 → `failed` (terminal non-`COMPLETED`)
   * - HTTP 503 → `running` (Temporal degraded — retry, never fail a poller)
   *
   * Throws `RunLifecycleUnavailableError` when the lifecycle routes are absent
   * (a bare runner).
   */
  async getRunResult(
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunResultState> {
    const endpoint = `${RUNS}/${encodeURIComponent(runId)}/results`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });

    if (res.status === 202 || res.status === 503) {
      return {
        state: "running",
        pipeline_run_id: runId,
        retry_after_seconds: parseRetryAfter(res.headers) ?? DEFAULT_DEGRADED_RETRY_SECONDS,
      };
    }
    if (res.status === 409) {
      const { serverMessage } = parseErrorBody(res.body);
      const message = serverMessage ?? "Run finished without a result.";
      return {
        state: "failed",
        pipeline_run_id: runId,
        status: extractRunStatusFromMessage(message),
        message,
      };
    }
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const result = JSON.parse(res.body) as RunResults;
    if (result.main_stuff == null) {
      throw new MissingMainStuffError(
        `Completed run '${runId}' returned no main stuff — a completed run always delivers a main stuff.`,
        runId,
      );
    }
    return { state: "completed", pipeline_run_id: runId, result };
  }

  /** Poll an already-started run (by id) until it reaches a terminal state. */
  async waitForResult(runId: string, options?: WaitForResultOptions): Promise<RunResults> {
    return pollUntilResult((id, opts) => this.getRunResult(id, opts), runId, options);
  }

  /**
   * Whether the configured server serves the durable run lifecycle, decided
   * via the `GET /v1/version` handshake and cached for the client's lifetime. A
   * bare `pipelex-api` runner has no run store; anything else is assumed hosted.
   * When the handshake itself fails, assume hosted (the SDK default) and let the
   * start call surface the real error.
   */
  private async supportsRunLifecycle(): Promise<boolean> {
    if (this.lifecycleAvailable === undefined) {
      try {
        const info = await this.version();
        const impl = info.implementation;
        this.lifecycleAvailable = !(
          typeof impl === "string" && impl === BARE_RUNNER_IMPLEMENTATION
        );
      } catch {
        this.lifecycleAvailable = true;
      }
    }
    return this.lifecycleAvailable;
  }

  /**
   * Start a run and wait for its result.
   *
   * - **Hosted** (per the `/v1/version` handshake): durable start + poll, the
   *   path that survives the gateway's ~30s synchronous ceiling.
   * - **Bare runner** (no run store): the blocking `POST /v1/execute`, which
   *   has no gateway cap off-platform and returns the native `pipe_output`.
   */
  async startAndWaitForResult(
    options: StartOptions,
    pollOptions?: WaitForResultOptions,
  ): Promise<RunResults> {
    if (await this.supportsRunLifecycle()) {
      // A runner can look hosted yet lack the durable routes — `implementation`
      // is an extension field, so a compliant bare runner that omits it is
      // misdetected here. Such a runner raises `RunLifecycleUnavailableError`
      // from `start()`, BEFORE any run is created, so falling back to the
      // blocking path cannot double-run. Cache the negative so later calls skip
      // the durable attempt.
      let ack: RunResultStart;
      try {
        ack = await this.start(options);
      } catch (err) {
        if (!(err instanceof RunLifecycleUnavailableError)) throw err;
        this.lifecycleAvailable = false;
        return this.executeBlocking(options);
      }
      return this.waitForResult(ack.pipeline_run_id, pollOptions);
    }

    return this.executeBlocking(options);
  }

  // ── Pipelex product surface (hosted management routes) ─────────────────
  //
  // The hosted catalog/account routes the webapp drives. Every one rides the
  // same `{base}/v1/*` surface, `Authorization: Bearer`, org-from-JWT contract
  // as the protocol routes, and maps a non-2xx `problem+json` to a typed
  // `ApiResponseError` (branch on `.code`, not the status).

  /** The authenticated user's profile — `GET /v1/me`. */
  async getMe(): Promise<UserProfile> {
    return this.requestProduct("GET", "me");
  }

  /** List the caller's saved methods — `GET /v1/methods`. */
  async listMethods(): Promise<MethodData[]> {
    return this.requestProduct("GET", "methods");
  }

  /** Fetch one method by id — `GET /v1/methods/{id}`. */
  async getMethod(methodId: string): Promise<MethodData> {
    return this.requestProduct("GET", `methods/${encodeURIComponent(methodId)}`);
  }

  /** Create a method — `POST /v1/methods`. */
  async createMethod(input: MethodWriteInput): Promise<MethodData> {
    return this.requestProduct("POST", "methods", input);
  }

  /** Replace a method (rename = changed `name`) — `PUT /v1/methods/{id}`. */
  async updateMethod(methodId: string, input: MethodWriteInput): Promise<MethodData> {
    return this.requestProduct("PUT", `methods/${encodeURIComponent(methodId)}`, input);
  }

  /** Delete a method — `DELETE /v1/methods/{id}`. */
  async deleteMethod(methodId: string): Promise<void> {
    await this.requestProduct("DELETE", `methods/${encodeURIComponent(methodId)}`);
  }

  /** The caller's org memberships + active-org feature flags — `GET /v1/organizations/memberships`. */
  async listMemberships(): Promise<MembershipsResponse> {
    return this.requestProduct("GET", "organizations/memberships");
  }

  /** Create an organization — `POST /v1/organizations`. */
  async createOrganization(input: { name: string }): Promise<Membership> {
    return this.requestProduct("POST", "organizations", input);
  }

  /** Rename an organization — `PATCH /v1/organizations/{org_id}`. */
  async renameOrganization(orgId: string, input: { name: string }): Promise<Membership> {
    return this.requestProduct("PATCH", `organizations/${encodeURIComponent(orgId)}`, input);
  }

  /** The active org's subscription state — `GET /v1/billing/subscription`. */
  async getSubscription(): Promise<SubscriptionResponse> {
    return this.requestProduct("GET", "billing/subscription");
  }

  /** Available plans (with `is_current`) — `GET /v1/billing/plans`. */
  async listPlans(): Promise<PlanView[]> {
    return this.requestProduct("GET", "billing/plans");
  }

  /** Past invoices — `GET /v1/billing/invoices`. */
  async listInvoices(): Promise<InvoiceView[]> {
    return this.requestProduct("GET", "billing/invoices");
  }

  /** Open a Stripe checkout for a plan — `POST /v1/billing/checkout`. */
  async createCheckout(input: { plan: string }): Promise<CheckoutResponse> {
    return this.requestProduct("POST", "billing/checkout", input);
  }

  /**
   * Switch the existing subscription's plan — `POST /v1/billing/change-plan`.
   * A 409 `conflict` (`ApiResponseError.code`) means there is no subscription
   * to change — start one via `createCheckout` first.
   */
  async changePlan(input: { plan: string }): Promise<ChangePlanResponse> {
    return this.requestProduct("POST", "billing/change-plan", input);
  }

  /**
   * A Stripe billing-portal session URL — `GET /v1/billing/portal`. A 409
   * `conflict` (`ApiResponseError.code`) means there is no subscription yet.
   */
  async getBillingPortal(): Promise<BillingPortalResponse> {
    return this.requestProduct("GET", "billing/portal");
  }

  /** List the caller's Pipelex API keys — `GET /v1/pipelex-api-keys`. */
  async listPipelexApiKeys(): Promise<PipelexApiKeyList> {
    return this.requestProduct("GET", "pipelex-api-keys");
  }

  /**
   * Mint a Pipelex API key — `POST /v1/pipelex-api-keys`. The plaintext
   * `api_key` is returned ONCE. A 409 `pipelex_api_key_limit_reached`
   * (`ApiResponseError.code`) means the per-account key limit is hit.
   */
  async createPipelexApiKey(input: { label: string }): Promise<PipelexApiKeyCreated> {
    return this.requestProduct("POST", "pipelex-api-keys", input);
  }

  /** Revoke a Pipelex API key — `DELETE /v1/pipelex-api-keys/{id}`. */
  async revokePipelexApiKey(id: string): Promise<void> {
    await this.requestProduct("DELETE", `pipelex-api-keys/${encodeURIComponent(id)}`);
  }

  /**
   * Rotate a Pipelex API key — `POST /v1/pipelex-api-keys/{id}/rotate` (no
   * body). Returns the new plaintext `api_key` once; the old key stops working.
   */
  async rotatePipelexApiKey(id: string): Promise<PipelexApiKeyCreated> {
    return this.requestProduct("POST", `pipelex-api-keys/${encodeURIComponent(id)}/rotate`);
  }

  /**
   * Provision the gateway (LLM inference) API key — `POST /v1/gateway-api-key`.
   * The JSON body is ALWAYS sent (even with `promo_code: null`) — the server
   * 422s an empty body.
   */
  async createGatewayApiKey(input: { promo_code: string | null }): Promise<GatewayApiKey> {
    return this.requestProduct("POST", "gateway-api-key", input);
  }

  /** The gateway key status (`null` until provisioned) — `GET /v1/gateway-api-key`. */
  async getGatewayApiKey(): Promise<GatewayApiKeyStatus> {
    return this.requestProduct("GET", "gateway-api-key");
  }

  /** Submit the onboarding questionnaire — `POST /v1/onboarding/submit`. */
  async submitOnboarding(input: OnboardingSubmission): Promise<void> {
    await this.requestProduct("POST", "onboarding/submit", input);
  }

  /** Resolve a storage URI to a presigned URL — `POST /v1/resolve-storage-url`. */
  async resolveStorageUrl(input: { uri: string }): Promise<ResolvedStorageUrl> {
    return this.requestProduct("POST", "resolve-storage-url", input);
  }

  /** Upload a base64 file — `POST /v1/upload`. */
  async upload(input: UploadInput): Promise<UploadedFile> {
    return this.requestProduct("POST", "upload", input);
  }

  /**
   * Upload one local asset and return its {@link UploadRecord} — the single-asset
   * convenience over {@link upload}. Accepts `Blob`/`File`/`ArrayBuffer`/`Uint8Array`
   * in every runtime; a path string is Node-only (it fails instructively elsewhere).
   * The record guarantees `uri`, `contentType`, `size`, and `filename`. Transport
   * failures surface as the semantic input-preparation errors (rejected asset, auth,
   * unsupported capability, transport). See `docs/input-preparation.md`.
   */
  async uploadFile(asset: UploadableAsset, options?: UploadFileOptions): Promise<UploadRecord> {
    return uploadFileImpl(this, asset, options);
  }

  /**
   * Prepare a pipe's inputs — resolve the declared signature, upload the
   * file-bearing assets, and return copy-on-write rewritten inputs (canonical
   * content carrying `pipelex-storage://` in `url`) plus one upload record per
   * prepared asset. HTTP(S) URLs and existing `pipelex-storage://` URIs pass
   * through unchanged; all failures are raised before any run is created. The
   * caller supplies the method closure as inline `files`. See
   * `docs/input-preparation.md`.
   */
  async prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs> {
    return prepareInputsImpl(this, request);
  }

  /** List a method's runs — `GET /v1/runs?method_id={methodId}`. */
  async listRuns(methodId: string): Promise<PipelineRun[]> {
    return this.requestProduct("GET", `runs?method_id=${encodeURIComponent(methodId)}`);
  }

  /** Patch a run's status (admin/manual) — `PUT /v1/runs/{id}`. */
  async updateRun(runId: string, input: UpdateRunInput): Promise<void> {
    await this.requestProduct("PUT", `runs/${encodeURIComponent(runId)}`, input);
  }

  /**
   * Blocking `POST /v1/execute` adapted onto `RunResults` — the bare-runner
   * path. Forwards every protocol field PLUS the `extra` extension passthrough:
   * an extension-only call (`{ extra }` with no pipe_code/bundle) or a vendor
   * selector riding `extra` must survive this path, not just the durable one.
   */
  private async executeBlocking(options: StartOptions): Promise<RunResults> {
    const response = await this.execute({
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      // Forward the method bundle so a custom-PipeFunc method falls back onto
      // the blocking path (bare runner / no run store) with its Python intact.
      files: options.files ?? undefined,
      bundle_b64: options.bundle_b64 ?? undefined,
      extra: options.extra ?? undefined,
    });
    return mapRunResultToRunResults(response);
  }
}

// ── Module helpers ────────────────────────────────────────────────────

/**
 * Whether a base URL is host-only — http/https, no path, query, fragment, or
 * embedded credentials (auth travels in the Authorization header, never the URL).
 * Endpoints compose as `{base}/v1/{endpoint}`, so a path-prefixed base would
 * double the prefix.
 */
function isValidBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
  if (parsed.username || parsed.password) return false;
  return !parsed.search && !parsed.hash;
}

/**
 * Map the protocol's blocking `POST /v1/execute` response onto the lifecycle's
 * `RunResults`. `response.main_stuff` resolves the main output out of the returned
 * working memory (and throws `MissingMainStuffError` if the run named no locatable
 * main stuff), so the durable and blocking paths hand back the same `main_stuff`
 * content shape — the same shape the hosted path relays from S3. The full working
 * memory rides `pipe_output` (blocking only).
 */
function mapRunResultToRunResults(response: PipelexExecuteResult): RunResults {
  // The usage pair rides `pipe_output` as Pipelex extension fields, beside `working_memory`
  // — `DictPipeOutput` is extension-open, mirroring the Python model's `extra="allow"`, so
  // it is read through the type rather than by casting the whole value away. Lifting the
  // pair onto the two top-level fields is what makes `.tokens_usages` read the same on the
  // blocking and durable paths. The remaining casts are unavoidable: an index-signature read
  // is `unknown`, and this is unvalidated server JSON.
  return {
    pipeline_run_id: response.pipeline_run_id,
    main_stuff: response.main_stuff,
    // The bare-runner blocking `pipe_output` carries no graph artifact; the
    // hosted graph_spec rides the durable `/v1/runs/{id}/results` payload.
    graph_spec: null,
    pipe_output: response.pipe_output,
    tokens_usages: (response.pipe_output["tokens_usages"] ?? null) as RunResults["tokens_usages"],
    usage_assembly_error: (response.pipe_output["usage_assembly_error"] ??
      null) as RunResults["usage_assembly_error"],
  };
}

// The protocol's own request fields — `extra` is for extension args only.
// `files` / `bundle_b64` (the Pipelex-API method-bundle transport) are reserved
// too: they are named run-source options, so smuggling them through `extra`
// (which merges last into the body) would overwrite the validated fields and
// bypass the run-source exclusivity check.
const PROTOCOL_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "pipe_code",
  "mthds_contents",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
  "files",
  "bundle_b64",
]);

/**
 * Does the request carry a method bundle (the Pipelex-API `files` / `bundle_b64`
 * transport, which lets custom PipeFunc Python travel with the method)? A bundle
 * is self-contained — it carries its own `.mthds` — so it satisfies the
 * "something to run" precondition on its own, without `pipe_code` / `mthds_contents`.
 */
function hasBundlePayload(options: RunOptions): boolean {
  const hasFiles = options.files != null && Object.keys(options.files).length > 0;
  const hasZip = options.bundle_b64 != null && options.bundle_b64.length > 0;
  return hasFiles || hasZip;
}

/**
 * Enforce the run-source exclusivity contract before dispatch, so a conflicting
 * request fails as a clear `PipelineRequestError` here rather than an opaque
 * server `422`. A method bundle is self-contained, so it cannot ride alongside
 * `mthds_contents`, and `files` / `bundle_b64` are two encodings of one bundle.
 * Exclusivity keys off PRESENCE (an empty-but-supplied encoding still counts) —
 * `mthds_contents` counts only when non-empty. Mirrors the server's validator.
 */
function assertExclusiveRunSources(options: RunOptions): void {
  const hasFiles = options.files != null;
  const hasZip = options.bundle_b64 != null;
  const hasContents = options.mthds_contents != null && options.mthds_contents.length > 0;
  if (hasFiles && hasZip) {
    throw new PipelineRequestError(
      "files and bundle_b64 are two encodings of the same bundle and are mutually exclusive; provide one.",
    );
  }
  if ((hasFiles || hasZip) && hasContents) {
    throw new PipelineRequestError(
      "A method bundle (files/bundle_b64) is self-contained; it cannot be combined with mthds_contents.",
    );
  }
}

/** An empty map is not a runnable bundle; drop it so the runner never sees a zero-file bundle. */
function nonEmptyFiles(
  files: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  return files != null && Object.keys(files).length > 0 ? files : undefined;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined;
}

/**
 * Validate and copy the generic `extra` passthrough. Extension args ride the
 * request body as top-level properties; protocol args must be passed as named
 * options, never smuggled through `extra`.
 */
function buildExtensions(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  const overlap = Object.keys(extra).filter((key) => PROTOCOL_REQUEST_KEYS.has(key));
  if (overlap.length > 0) {
    throw new PipelineRequestError(
      `extra carries protocol args [${overlap.sort().join(", ")}] — pass them as named options instead.`,
    );
  }
  return { ...extra };
}

function withValidateMarkdownRender(render: string[] | undefined): string[] {
  const formats = new Set(render ?? []);
  formats.add(VALIDATE_MARKDOWN_RENDER_FORMAT);
  return [...formats];
}

// The hosted gateway caps synchronous requests at 30s. A failure at/after this
// threshold on the blocking execute is the timeout, not a transient outage —
// the threshold guards against mislabelling a fast 503 (runner genuinely down)
// as a timeout.
const GATEWAY_TIMEOUT_THRESHOLD_MS = 28_000;

function isGatewayTimeout(err: unknown, elapsedMs: number): boolean {
  if (elapsedMs < GATEWAY_TIMEOUT_THRESHOLD_MS) return false;
  if (err instanceof ApiResponseError) return err.status === 503 || err.status === 504;
  if (err instanceof ApiUnreachableError) return err.code === "ABORT_TIMEOUT";
  return false;
}

function extractNetworkErrorCode(err: unknown): string | undefined {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "ABORT_TIMEOUT";
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

/**
 * Whether a 404 is an unmatched-route 404 (no platform deployed) rather than
 * the platform's structured run-not-found 404. The platform wraps its 404s in
 * a structured envelope with a stable `code`; a bare runner returns
 * Starlette's default `{"detail": "Not Found"}` (no `code`).
 */
function isMissingRoute404(body: string): boolean {
  if (!body) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  return !("code" in parsed);
}

/** Parse the `Retry-After` header (seconds form, which the platform uses). */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const KNOWN_RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "STARTED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
];

/**
 * The 409 detail reads "Run finished with status FAILED; no result available".
 * Pull the status word out; default to FAILED if the shape ever changes.
 */
function extractRunStatusFromMessage(message: string): RunStatus {
  const match = message.match(/status\s+([A-Z_]+)/);
  const candidate = match?.[1];
  if (candidate && (KNOWN_RUN_STATUSES as readonly string[]).includes(candidate)) {
    return candidate as RunStatus;
  }
  return "FAILED";
}

/**
 * The API serializes errors as `{"detail": {"error_type": ..., "message": ...}}`
 * (HTTPException with dict detail) or `{"detail": "..."}` (auth 401s and RFC
 * 7807 problems). Both shapes are extracted here. An invalid-bundle 422 problem
 * additionally carries a top-level `validation_errors[]` list (the
 * `ValidateBundleError` extension projected onto the envelope). Falls through
 * silently on non-JSON bodies.
 */
function parseErrorBody(body: string): {
  errorType: string | undefined;
  serverMessage: string | undefined;
  validationErrors: ValidationErrorItem[] | undefined;
  code: string | undefined;
} {
  const empty = {
    errorType: undefined,
    serverMessage: undefined,
    validationErrors: undefined,
    code: undefined,
  };
  if (!body) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") {
    return empty;
  }
  const root = parsed as Record<string, unknown>;
  const detail = root.detail;
  let errorType: string | undefined;
  let serverMessage: string | undefined;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.error_type === "string") errorType = d.error_type;
    if (typeof d.message === "string") serverMessage = d.message;
  } else if (typeof detail === "string") {
    serverMessage = detail;
  }
  if (errorType === undefined && typeof root.error_type === "string") errorType = root.error_type;
  if (serverMessage === undefined && typeof root.message === "string") serverMessage = root.message;
  // `validation_errors` rides the problem envelope as a top-level array (the
  // VERBOSE projection of `ErrorReport.validation_errors`, retained under STRICT
  // too — it describes the caller's own bundle, not server internals). Kept as a
  // shallow array guard; per-item shape is the typed `ValidationErrorItem` contract.
  const validationErrors = Array.isArray(root.validation_errors)
    ? (root.validation_errors as ValidationErrorItem[])
    : undefined;
  // The product routes' RFC 9457 `problem+json` carries a stable top-level
  // `code` discriminant (`conflict`, `not_found`, …) — the field consumers
  // branch on, decoupled from the HTTP status.
  const code = typeof root.code === "string" ? root.code : undefined;
  return { errorType, serverMessage, validationErrors, code };
}

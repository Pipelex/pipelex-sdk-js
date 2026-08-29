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
// Run-source predicates come from the standard, not a local restatement: which
// source combinations are legal is an invariant of `RunRequest` itself, so this
// client and the MTHDS runners cannot disagree about what they reject.
import {
  assertExclusiveRunSources,
  hasBundlePayload,
  parseMethodFiles,
  serializeMethodFiles,
} from "mthds/protocol";
import type {
  BuildInputsRequest,
  BuildInputsResponse,
  BuildOutputRequest,
  BuildOutputResponse,
  BuildRunnerRequest,
  BuildRunnerResponse,
  CodegenRequest,
  CodegenResponse,
  ConceptRequest,
  ConceptResponse,
  CrateRequestBase,
  DictPipeOutput,
  DictRunResultExecute,
  FormatResponse,
  LintResponse,
  MthdsFileItem,
  PipeSpecRequest,
  PipeSpecResponse,
  PipelexRunResultStart,
  PipelexValidationResult,
  ResolveRequest,
  ResolveResponse,
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
  ListMethodsQuery,
  MethodData,
  MethodDeletionAccepted,
  MethodPage,
  MethodSummary,
  MethodWriteInput,
  OnboardingSubmission,
  PipelexApiKeyCreated,
  PipelexApiKeyList,
  ListRunsQuery,
  PipelineRun,
  RunDetail,
  RunPage,
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
  EmptyMethodSourceError,
  MissingMainStuffError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
} from "./errors.js";
import { methodSourceToContents } from "./method-source.js";
import { uploadFile as uploadFileImpl } from "./upload.js";
import type { UploadableAsset, UploadFileOptions, UploadRecord } from "./upload.js";
import { prepareInputs as prepareInputsImpl } from "./prepare-inputs.js";
import type { PrepareInputsRequest, PreparedInputs } from "./prepare-inputs.js";
import { PipelexExecuteResult } from "./execute-result.js";

// A pure RUNAWAY guard on `iterateMethods`, deliberately not a coverage limit.
//
// It counts TOTAL pages, not empty ones. An earlier version capped consecutive
// empty pages, which is the wrong axis: an empty page whose cursor ADVANCED is
// real progress through the index — the platform applies `q` as a post-read
// filter over a bounded slice per request, so a sparse match legitimately
// yields runs of empty pages — and capping them turns a valid sparse search
// into a thrown error. The stuck case is already caught by the no-progress
// check (the server handing back the cursor we sent).
//
// At the platform's 200-row maximum page size this is 2,000,000 methods, so it
// cannot fire on real data; it exists only so a server minting fresh cursors
// forever cannot hang a caller indefinitely.
const MAX_PAGES = 10_000;

export interface MthdsFile {
  /** File contents to validate. */
  content: string;
  /** Optional provenance URI threaded into validation diagnostics. */
  uri?: string;
}

/**
 * The Pipelex API's own run-source extension — the layer-2 argument the RUNNER
 * itself resolves, beside the protocol's inline sources (`mthds_contents` and
 * the bundle encodings). Served by any pipelex-api >= 0.21.0 deployment, bare
 * or hosted (on `api.pipelex.com`, once the platform deploy carrying it lands).
 *
 * Named options rather than `extra` entries, for the same reason as the hosted
 * extensions below: `extra` remains the escape hatch for an extension this
 * client does not know about, never the way to pass one it does.
 */
export interface PipelexApiRunExtensions {
  /**
   * A published method's address — `github.com/<owner>/<repo>[/<selector>][@<tag>]`
   * (e.g. `github.com/Pipelex/methods/documents@v0.1.0`). Resolved by the
   * server: the repository is fetched at the tag (a bare address means the
   * default branch at HEAD), the package is located by manifest identity, and
   * the resolved commit SHA comes back as `method_provenance` on the response.
   *
   * A complete run source of its own — the fetched package carries its `.mthds`
   * and its entry pipe — so it pairs with NOTHING: exclusive with inline
   * `mthds_contents`, with a method bundle (`files` / `bundle_b64`), and with
   * the hosted `method_id` (an address run has its own provenance and needs no
   * linkage id). `pipe_code` beside it is fine — it overrides the manifest's
   * `main_pipe` to pick which pipe in the fetched package to run. This client
   * rejects the illegal pairings before anything hits the wire, mirroring the
   * server's own 422s.
   *
   * An empty string is treated as absent and is not sent.
   */
  method_ref?: string | null;
}

/**
 * The hosted API's own run arguments — the layer-3 extensions this client adds
 * on top of the MTHDS Protocol's run-argument surface (`RunOptions` /
 * `StartOptions`, which stay pure).
 *
 * They are named options rather than `extra` entries because that is the one
 * job a hosted client exists to do: `extra` remains the escape hatch for an
 * extension this client does not know about, never the way to pass one it does.
 * That split is normative for every client in the layered stack — it is not a
 * preference of this one.
 */
export interface PipelexHostedRunExtensions {
  /**
   * A stored method's catalog id (`mt_…`) — a **pass-through to the hosted
   * API**, resolved server-side against the org's catalog. Nothing is expanded
   * client-side, and it is meaningless off-platform: an open-source runner has
   * no catalog, so it answers a `422` naming the key.
   *
   * Its meaning depends on what else the request carries:
   *
   * - **Alone** — the platform resolves the stored method's source (assembling
   *   its bundle when the method carries Python) and runs that.
   * - **Alongside an inline source** (`mthds_contents` / `files` / `bundle_b64`)
   *   — the inline source is what RUNS (precedence), and the id is recorded as
   *   **run-history linkage** on the Run row. That linkage is what writes the
   *   index key `GET /v1/runs?method_id=` queries, so a run started without it
   *   is absent from its method's history permanently.
   * - **Alongside `method_ref`** — rejected client-side (and a 422 on the
   *   hosted API): an address run carries its own provenance, so it takes no
   *   linkage id.
   *
   * An empty string is treated as absent and is not sent.
   */
  method_id?: string | null;
}

/** `execute()` options — the protocol's run arguments plus the Pipelex API and hosted extensions. */
export type PipelexRunOptions = RunOptions & PipelexApiRunExtensions & PipelexHostedRunExtensions;

/** `start()` / `startAndWaitForResult()` options — the same, for the durable path. */
export type PipelexStartOptions = StartOptions &
  PipelexApiRunExtensions &
  PipelexHostedRunExtensions;

/**
 * The method selector `validate()` takes in place of inline contents: a
 * `method_ref` address (server-resolved by the runner through the same fetch
 * path as a `method_ref` run) OR a hosted `method_id` (platform-resolved) —
 * never both. The tooling routes are stateless, so the strict XOR applies:
 * exactly one of inline contents / `method_ref` / `method_id` per request.
 */
export type ValidateMethodSelector =
  { method_ref: string; method_id?: never } | { method_id: string; method_ref?: never };

export interface ValidateFilesOptions {
  /** Whether unresolved pipe signatures are accepted as pending instead of invalid. */
  allowSignatures?: boolean;
  /** Optional validate presentation hints, e.g. ["markdown"]. */
  render?: string[];
  /** Optional structured-view opt-in tokens, e.g. ["input_form"]; sent only when given. */
  views?: string[];
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
 * - **crate extensions** (`/v1/resolve`, `/v1/codegen`) — the normalized library crate
 *   and the stamped typed artifacts projected from it.
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

// ── Methods catalog: typed `python` ⇄ wire string ────────────────────────
// The catalog stores a method's `python` as the serialized `[{ name, content }]`
// string; the public `MethodData`/`MethodWriteInput` type it as `MethodFile[]`.
// These wire shapes + converters are the one place the SDK (de)serializes it, via
// `mthds/protocol`'s canonical `parseMethodFiles`/`serializeMethodFiles`.

/** `MethodData` as it travels on the wire — `python` is the serialized catalog string. */
type MethodDataWire = Omit<MethodData, "python"> & { python?: string };
/** `MethodWriteInput` as it travels on the wire — `python` is the serialized catalog string. */
type MethodWriteWire = Omit<MethodWriteInput, "python"> & { python?: string };

/** Parse a wire method into the public shape (`python` → `MethodFile[]`). */
function methodDataFromWire(wire: MethodDataWire): MethodData {
  const { python, ...rest } = wire;
  return python == null ? rest : { ...rest, python: parseMethodFiles(python) };
}

/**
 * Serialize a write payload for the wire. `python` is three-way: OMITTED stays
 * omitted (preserve server-side); an array — including `[]` — is serialized (`[]`
 * → `""`, the clear sentinel; non-empty → the JSON array). It is never sent as an
 * array on the wire.
 */
function methodWriteToWire(input: MethodWriteInput): MethodWriteWire {
  const { python, ...rest } = input;
  return python === undefined ? rest : { ...rest, python: serializeMethodFiles(python) };
}

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
  async execute(options: PipelexRunOptions): Promise<PipelexExecuteResult> {
    const extensions = buildExtensions(options.extra);
    const api = buildApiRunExtensions(options);
    const hosted = buildHostedRunExtensions(options);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(api).length === 0 &&
      Object.keys(hosted).length === 0 &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64), a method_ref, a hosted method_id or a server-specific extension arg (extra) must be provided to execute().",
      );
    }
    assertExclusiveRunSources(options);
    assertMethodRefPairsWithNothing(options);

    const request: RunRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...api,
      ...hosted,
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
   * The `method_ref` address and the hosted `method_id` are named options (see
   * `PipelexApiRunExtensions` / `PipelexHostedRunExtensions`); `options.extra`
   * stays the generic passthrough for extension args this client does not know
   * about — the server you call defines and handles them (including a
   * client-supplied run id where a server supports one). The returned
   * `pipeline_run_id` is always authoritative; on a hosted deployment it is
   * durable — poll `getRunStatus` / `getRunResult`. A `method_ref` run's ack
   * additionally carries `method_provenance` — the address, the tag, and the
   * commit SHA that was actually fetched.
   */
  async start(options: PipelexStartOptions): Promise<PipelexRunResultStart> {
    const extensions = buildExtensions(options.extra);
    const api = buildApiRunExtensions(options);
    const hosted = buildHostedRunExtensions(options);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(api).length === 0 &&
      Object.keys(hosted).length === 0 &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64), a method_ref, a hosted method_id or a server-specific extension arg (extra) must be provided to start().",
      );
    }
    assertExclusiveRunSources(options);
    assertMethodRefPairsWithNothing(options);

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
      ...api,
      ...hosted,
      ...extensions,
    };

    const url = this.url("start");
    // `start` returns a 202 fast, so the poll timeout normally fits — with two
    // exceptions that get the blocking-execute ceiling instead. A method bundle
    // can make the request *body* multi-megabyte, and the whole upload is
    // charged against this budget — the same payload must not time out on the
    // durable path yet succeed on the fallback. And a `method_ref` start makes
    // the server FETCH the package before the ack (provenance rides the 202),
    // whose clone timeout runs well past 30s on a cold cache — aborting it here
    // would surface as `ApiUnreachableError`, blaming the network for a healthy
    // server that is still cloning.
    const needsLongCeiling =
      hasBundlePayload(options) || nonEmptyString(options.method_ref) !== undefined;
    const res = await this.requestRaw("POST", url, {
      body: request,
      timeoutMs: needsLongCeiling ? DEFAULT_REQUEST_TIMEOUT_MS : POLL_REQUEST_TIMEOUT_MS,
    });
    // A bare runner with no run store 404s here just as it does on the result
    // routes — surface the same clear `RunLifecycleUnavailableError` (and let
    // `startAndWaitForResult` fall back to the blocking `execute`).
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "start", res);
    }
    return JSON.parse(res.body) as PipelexRunResultStart;
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
   * `source` selects WHAT is validated, in exactly one of three forms — the
   * strict tooling XOR (the routes are stateless, so there is no linkage
   * exception; a second selector is a request-shape `422`):
   *
   * - **inline contents** (a `string[]`) — the protocol's own envelope;
   * - **`{ method_ref }`** — a published method's address, resolved by the
   *   server (pipelex-api >= 0.21.0) through the same fetch path as a
   *   `method_ref` run, the package's real file names feeding the diagnostics'
   *   source labels;
   * - **`{ method_id }`** — a stored method's catalog id, hosted-only: the
   *   platform resolves it and injects the stored source before the runner sees
   *   the request (a bare runner rejects the request as carrying no source it
   *   understands).
   *
   * A selector-resolution failure (fetch failure, no package at the address, an
   * unknown or foreign-org id) is a non-2xx `ApiResponseError` — never an
   * `is_valid: false` verdict, which is reserved for actual MTHDS content.
   *
   * `mthdsSources` (optional, parallel to inline contents) names each submitted
   * content — a Pipelex-API extension threaded onto `blueprint.source`, so
   * cross-file diagnostics name the owning file (an unnamed content yields
   * `source: null`). The server 422s a length mismatch; this client sends the
   * arrays verbatim and surfaces that as an `ApiResponseError`. It is an
   * inline-contents companion only: a `method_ref` / `method_id` validation gets
   * its source labels from the package's (or the stored method's) real file
   * names, so supplying it beside a selector is rejected client-side.
   *
   * `render` is the Pipelex-API presentation hint — a list of view-format tokens.
   * This client always asks for Markdown so both valid results and produced
   * validation-error verdicts carry `rendered_markdown`; callers may add more
   * tokens. Unknown tokens are server-side lenient-ignored (never a 422).
   *
   * `views` is the sibling opt-in for *structured* views where `render` carries
   * *rendered text*. The two lists are independent, each resolving its own tokens
   * against its own supported set, and each supported token adds a same-named
   * top-level field to the valid arm — today only `input_form`. Unlike `render`,
   * this client sends `views` ONLY when the caller asks: the point of an opt-in view
   * is that the default response stays byte-identical, and the highest-frequency
   * consumers (hook pipelines, CI gates, agent loops) never pay for bytes they
   * discard. `pipelex-api` gates `input_form` on this token as of 0.18.0; a 0.17.0
   * runner resolved no token (the key is silently ignored, never a 422) and emitted
   * the field regardless — which is why `PipelexValidationReport.input_form` is typed
   * optional rather than required.
   */
  async validate(
    source: string[] | ValidateMethodSelector,
    allowSignatures = false,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PipelexValidationResult> {
    const body: Record<string, unknown> = {
      allow_signatures: allowSignatures,
    };
    if (Array.isArray(source)) {
      body.mthds_contents = source;
      if (mthdsSources !== undefined) {
        body.mthds_sources = mthdsSources;
      }
    } else {
      // A selector object. The illegal shapes are compile errors for typed
      // callers (`ValidateMethodSelector` pins the other key to `never`); the
      // runtime checks back them for untyped (JS) callers — a typed
      // `PipelineRequestError`, never a native TypeError off a null source —
      // mirroring the server's strict tooling XOR instead of silently picking.
      if (source === null || source === undefined || typeof source !== "object") {
        throw new PipelineRequestError(
          "validate() takes inline contents (a string[]) or a method selector object " +
            "({ method_ref } or { method_id }).",
        );
      }
      const methodRef = nonEmptyString(source.method_ref);
      const methodId = nonEmptyString(source.method_id);
      if ((methodRef === undefined) === (methodId === undefined)) {
        throw new PipelineRequestError(
          "validate() takes exactly one method selector: inline contents, { method_ref }, or { method_id }.",
        );
      }
      if (mthdsSources !== undefined) {
        throw new PipelineRequestError(
          "mthds_sources labels inline mthds_contents; a method_ref / method_id validation gets " +
            "its source labels from the package's (or the stored method's) real file names.",
        );
      }
      if (methodRef !== undefined) body.method_ref = methodRef;
      if (methodId !== undefined) body.method_id = methodId;
    }
    body.render = withValidateMarkdownRender(render);
    if (views !== undefined) {
      body.views = views;
    }
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
      options.views,
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
    );
  }

  // ── Tools extensions (Pipelex API — `/v1/lint`, `/v1/format`) ─────────
  //
  // NOT REACHABLE ON ANY HOSTED ENVIRONMENT. Both are served by any `pipelex-api`
  // runner, but neither the gateway's API-key allowlist nor the platform's tooling
  // proxy lists them, so every `*.pipelex.com` origin answers a gateway
  // `403 {"message":"Forbidden"}` — refused before any service sees the request.
  // Measured 2026-08-19 and re-measured 2026-08-23 on prod AND api-dev: on the same
  // origin, with the same key, `validate` succeeds while these two 403.
  //
  // That blocks nothing, because lint and format are toolchain capabilities rather
  // than hosted ones: `plxt` carries both, and the post-edit hook this repo builds
  // (`npm run build:hook`) runs them offline through `@pipelex/tools-wasm` with no
  // credentials (see `src/hooks/claude-mthds-check.ts`), with these two methods as the
  // published package's documented fallback against a runner. The crate
  // routes (`resolve`/`codegen`) shared this gap and are now exposed everywhere;
  // these two were not included, a known non-critical item on the platform's list.
  // Tracked in `wip/hosted-exposure-crate-and-tools-routes.md`.

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
   * POST one of the Pipelex-API extension routes — the tools (`lint`, `format`), the
   * crate routes (`resolve`, `codegen`), and the build projections (`build/*`). Their
   * non-2xx bodies are RFC 7807 problems, mapped to the typed `ApiResponseError` like
   * the product routes.
   *
   * The mapping is what makes their no-verdict arms usable: a crate-family route
   * answers `422` for a request it cannot act on (an unresolvable pipe selector on the
   * build routes; an unknown `kind`/`target`, or a `pipe_ref` on the concept-set-wide
   * `types` kind, on `codegen`) and `501` for the reserved registry-form `method_ref`
   * (the address form is resolved server-side as of pipelex-api 0.21.0). A caller
   * branches on `ApiResponseError.status`, never on a message.
   *
   * All of these are inference-free, so they default to the management-call timeout.
   * `build/runner` is the exception — it dry-run-sweeps the closure — and overrides it
   * via `timeoutMs`.
   *
   * **The static routes deliberately expose no `timeoutMs` / `signal`, and that is not
   * an oversight to be "fixed" per route.** Automated reviewers have proposed adding
   * them to whichever route was newest more than once; the reasons they are absent are:
   *
   * 1. The split tracks the **dry-run sweep**, not the age of the route. `build/runner`
   *    is slow because it sweeps (the whole closure when `pipe_ref` is omitted); every
   *    other extension route rides the static core (`crate_ops.py` is explicit that
   *    `build/runner` "is the exception — it needs the dry-run sweep"). Giving one
   *    static route an override while its siblings lack one is the inconsistency.
   * 2. The input is **bounded server-side** — `pipelex-api/api/limits.py` caps a request
   *    at 16 `.mthds` files of 1 MiB each — and none of these routes runs inference.
   * 3. On the hosted path an override would be **inert**: the gateway caps responses at
   *    ~30s (see `POLL_REQUEST_TIMEOUT_MS` above), so raising `timeoutMs` would still be
   *    cut off upstream, just with a less honest error.
   *
   * If a static route ever genuinely needs longer, give the WHOLE static family one
   * uniform transport-options parameter in a single pass — do not bolt it onto one
   * route.
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

  // ── Crate extensions (Pipelex API — `/v1/resolve`, `/v1/codegen`) ─────
  //
  // Served by any `pipelex-api` runner AND on every hosted origin. On the hosted
  // plane a route is reachable only when the gateway's API-key allowlist and the
  // platform's tooling proxy both list it — they each enumerate routes explicitly
  // (`validate`, `models`, `build/*`, …), and an unlisted path answers a gateway
  // `403 {"message":"Forbidden"}`, refused before any service sees it, so not even
  // an RFC 7807 problem body. Both list `resolve` and `codegen`.
  //
  // Measured 2026-08-23 with a real key: api.pipelex.com (pipelex-hosted@0.10.1)
  // serves both, verdict discipline intact (200 `is_valid:false`, 501, 422);
  // api-dev.pipelex.com has since 2026-08-13. `lint`/`format` are the two still
  // unexposed — see their section above for why that blocks nothing.
  //
  // Both are STATIC routes (no dry-run sweep), so like every static sibling they take
  // no `timeoutMs`/`signal` — see the policy note on `requestExtension` before adding
  // one here.

  /**
   * Resolve a closure into its normalized library crate — `POST /v1/resolve`.
   *
   * Resolution is a first-class language operation alongside validation: the closure is
   * loaded and statically validated, then emitted as the **normalized library crate**
   * (fully qualified refs, refinement flattened, natives materialized, fingerprint set)
   * — the MTHDS standard's Library Crate Format. It runs NO dry-run sweep, so a valid
   * verdict here says the library resolves, never that it runs; that is `validate`'s
   * vocabulary.
   *
   * Returns a **200 verdict**: pattern-match `is_valid` before reading the arm — a
   * closure that does not parse/load/validate comes back as `is_valid: false` with
   * `validation_errors[]`, not as a thrown error. Only a no-verdict condition throws
   * `ApiResponseError`: a malformed selector (none, or more than one, of
   * `files` / `method_ref` / `method_id`) is a 422; a selector-resolution failure
   * (fetch failure, no package at the address, an unknown or foreign-org id) is
   * non-2xx too — never an `is_valid: false` verdict.
   *
   * The closure arrives in exactly one of three forms: inline `files`, an
   * address-form `method_ref` (server-resolved, pipelex-api >= 0.21.0; the
   * registry form stays a `501`), or a hosted `method_id` (platform-resolved —
   * see {@link PipelexHostedToolingExtensions}).
   */
  async resolve(request: ResolveRequest): Promise<ResolveResponse> {
    return this.requestExtension("resolve", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
  }

  /**
   * Project a closure's crate into stamped typed artifacts — `POST /v1/codegen`.
   *
   * Resolves the closure exactly like {@link resolve}, then projects the crate through
   * the two explicit axes — `kind` (`types` today) × `target` (`ts-zod` for TypeScript
   * consumers, `python-pydantic`, `python-structures`) — and returns the artifact set
   * plus its `codegen.lock`. Write both verbatim and the tree is byte-identical to a
   * local `pipelex codegen types` run, so the offline `pipelex codegen check` passes on
   * it; the SDK deliberately does not write files for you.
   *
   * Same 200-verdict discipline and same three-form closure selector as
   * {@link resolve}. Only a no-verdict condition throws `ApiResponseError`: an
   * unknown `kind`/`target`, a `pipe_ref` on the concept-set-wide `types` kind, or
   * a malformed selector is a 422; a registry-form `method_ref` is a `501`.
   */
  async codegen(request: CodegenRequest): Promise<CodegenResponse> {
    return this.requestExtension("codegen", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
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
   *
   * Accepts the closure as inline `files` or as a `method_ref` (both on the wire
   * model {@link BuildInputsRequest}; the address form is server-resolved, the
   * registry form `501`s) — exactly one of the two, like `buildOutput` /
   * `buildRunner`. There is NO by-id form: the build routes take no `method_id`
   * (the hosted tooling selector covers `validate`/`resolve`/`codegen` only), so a
   * stored method is expanded first — `buildInputs({ files: await
   * client.getMethodClosure(methodId) })`.
   */
  async buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse> {
    // `method_id` is `never` in the type; this backs it for untyped (JS)
    // callers migrating off the retired client-side by-id expansion — a
    // teaching error beats the server silently ignoring an unknown key.
    if ((request as unknown as Record<string, unknown>)["method_id"] !== undefined) {
      throw new PipelineRequestError(
        "buildInputs takes no method_id — the build routes have no by-id form. Expand the stored " +
          "method first: buildInputs({ files: await client.getMethodClosure(methodId) }).",
      );
    }
    return this.requestExtension("build/inputs", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
  }

  /**
   * Project a pipe's output concept — `POST /v1/build/output`. Same envelope and
   * same 200-verdict discipline as {@link buildInputs}. `format: "schema"` (the
   * default) and `"json"` put a parsed object in `output`; `"python"` puts source
   * text in `output_python`.
   */
  async buildOutput(request: BuildOutputRequest): Promise<BuildOutputResponse> {
    return this.requestExtension("build/output", request, {
      timeoutMs: crateRequestTimeoutMs(request),
    });
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
   * routes use, and it is the ONLY extension route that takes transport options at all
   * (the policy note on `requestExtension` says why the static ones do not). Override it
   * per call with `options.timeoutMs`; a caller that stops caring mid-sweep can cancel
   * via `options.signal` instead of waiting it out.
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
    options: PipelexStartOptions,
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

  /**
   * One page of the org's method catalog, newest first — `GET /v1/methods`.
   *
   * **This returns a page, not an array.** It used to be
   * `Promise<MethodData[]>` — the whole catalog, every method carrying its full
   * `.mthds` bundle. That response hit DynamoDB's 1 MB page cap at a couple
   * hundred methods and came back TRUNCATED, with no error and no flag, so
   * methods simply disappeared from the UI. Code that rendered that array
   * directly should now either read `page.items` (accepting the first page) or
   * follow the cursor — `iterateMethods` does the latter for you.
   *
   * Rows are `MethodSummary`: no `mthds`, no `python`, no `updated_at`. Reach
   * for `getMethod(id)` when you need a method's source.
   *
   * `q` is applied server-side over the whole catalog, not over the page.
   */
  async listMethods(query: ListMethodsQuery = {}): Promise<MethodPage> {
    const params = new URLSearchParams();
    // `!== undefined`, not truthiness — mirroring `listRuns`. Omission means
    // "the caller did not ask"; an explicit empty string is bad input and the
    // API should say so, rather than being silently dropped into an unfiltered
    // query that returns everything and reads as working.
    if (query.q !== undefined) params.set("q", query.q);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const suffix = params.toString();
    const page = await this.requestProduct<{
      items: MethodSummary[];
      next_cursor: string | null;
    }>("GET", suffix ? `methods?${suffix}` : "methods");
    return { items: page.items, nextCursor: page.next_cursor };
  }

  /**
   * Every method in the catalog, streamed — follows the cursor for you.
   *
   * ```ts
   * for await (const method of client.iterateMethods()) {
   *   if (isTheOne(method)) break;   // stop whenever you like
   * }
   * ```
   *
   * **Prefer `listMethods`** for anything user-facing: this is O(catalog) by
   * construction and makes as many round trips as the data demands.
   *
   * An iterator rather than a `listAllMethods(): Promise<MethodSummary[]>`, for
   * the same reason `iterateRuns` is one: an all-at-once helper needs a page cap
   * so a misbehaving server cannot spin it forever, and a cap means it returns a
   * TRUNCATED list with no error — precisely the bug paging was introduced to
   * remove. If you truly want an array, `Array.fromAsync` makes that your
   * explicit choice.
   */
  async *iterateMethods(
    query: Omit<ListMethodsQuery, "cursor"> = {},
  ): AsyncGenerator<MethodSummary, void, undefined> {
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page: MethodPage = await this.listMethods({ ...query, cursor });

      // Checked BEFORE yielding: a server handing back the very cursor we sent
      // has not advanced, so this page repeats rows already emitted. Cannot
      // fire on the first request, where `cursor` is undefined.
      if (cursor !== undefined && page.nextCursor === cursor) return;

      for (const method of page.items) yield method;

      // `nextCursor === null` is the NORMAL end of the catalog, and that page
      // is real data, so it has to be emitted before this fires.
      if (page.nextCursor === null) return;

      // An EMPTY page is NOT the end, and treating it as one was a bug. The
      // platform applies `q` as a post-read filter over a bounded number of
      // index pages per request, so a sparse match legitimately returns
      // `{items: [], nextCursor: "…"}` — "nothing matched in the slice I just
      // read, keep going". Returning here dropped every later match silently,
      // which is the exact truncation this pagination work exists to remove.
      // (`iterateRuns` can stop on an empty page because its date bounds are
      // index KEY conditions, so a run page is never empty-with-a-cursor. The
      // difference is the server, not the client.)
      pages += 1;
      if (pages >= MAX_PAGES) {
        // THROW, do not return. A caller that asked for every method and got a
        // partial answer with no error is back to the original bug one layer
        // up; an error is the only honest response to a server that will not
        // finish. Unreachable on real data — see MAX_PAGES.
        throw new Error(
          `listMethods did not terminate after ${MAX_PAGES} pages; refusing to keep paging. ` +
            `This is a server-side fault, not a coverage limit.`,
        );
      }
      cursor = page.nextCursor;
    }
  }

  /** Fetch one method by id — `GET /v1/methods/{id}`. */
  async getMethod(methodId: string): Promise<MethodData> {
    const wire = await this.requestProduct<MethodDataWire>(
      "GET",
      `methods/${encodeURIComponent(methodId)}`,
    );
    return methodDataFromWire(wire);
  }

  /**
   * Resolve a stored method's id into its runnable MTHDS closure — a client-side
   * semantic layer over `getMethod` (the platform has no route that returns a
   * parsed closure). Fetches the method, parses its polymorphic `mthds` source
   * with `methodSourceToContents`, and labels each resulting file with the
   * `method_id` as its `source` provenance.
   *
   * This is the LOCAL expansion utility — for callers that want the files in
   * hand (to edit, to diff, to feed a route with no by-id form such as
   * `/v1/build/*` or `prepareInputs`). The routes that accept `method_id`
   * natively (`execute`/`start`, and `validate`/`resolve`/`codegen` on the
   * hosted API) take the id as a pass-through instead; nothing in this client
   * expands an id behind your back.
   *
   * Requires an API key: the methods catalog is org-scoped to the key's org, so
   * an unknown OR foreign-org id is a `getMethod` `404` (`ApiResponseError`
   * `not_found`), which propagates unchanged. A real, in-org method whose source
   * parses to nothing throws `EmptyMethodSourceError` (distinct from the 404) —
   * the row exists but has no runnable source yet.
   */
  async getMethodClosure(methodId: string): Promise<MthdsFileItem[]> {
    const method = await this.getMethod(methodId);
    const contents = methodSourceToContents(method.mthds);
    if (contents.length === 0) {
      throw new EmptyMethodSourceError(methodId);
    }
    return contents.map((content) => ({ content, source: methodId }));
  }

  /** Create a method — `POST /v1/methods`. */
  async createMethod(input: MethodWriteInput): Promise<MethodData> {
    const wire = await this.requestProduct<MethodDataWire>(
      "POST",
      "methods",
      methodWriteToWire(input),
    );
    return methodDataFromWire(wire);
  }

  /** Replace a method (rename = changed `name`) — `PUT /v1/methods/{id}`. */
  async updateMethod(methodId: string, input: MethodWriteInput): Promise<MethodData> {
    const wire = await this.requestProduct<MethodDataWire>(
      "PUT",
      `methods/${encodeURIComponent(methodId)}`,
      methodWriteToWire(input),
    );
    return methodDataFromWire(wire);
  }

  /**
   * Erase a method and everything it produced — `DELETE /v1/methods/{id}`.
   *
   * **Asynchronous, and the return value says so.** The platform answers `202`
   * the moment it has claimed the method and terminated its in-flight
   * workflows; the rest of the cascade (runs, events, S3 objects) is enqueued.
   * So a resolved promise means "accepted", never "gone" — completion is the
   * method's row disappearing from `listMethods`, not any field of the
   * acceptance body. Until then the row stays listed with a `deletion_state`,
   * which is what lets a UI render it as "Deleting…", while `getMethod` refuses
   * it with a `409`.
   *
   * A double-clicked delete is safe: the claim is a conditional write, so the
   * second call is an `ApiResponseError` (`409 conflict`) rather than a second
   * cascade over the same runs. An unknown or foreign-org id is a `404`.
   */
  async deleteMethod(methodId: string): Promise<MethodDeletionAccepted> {
    return this.requestProduct("DELETE", `methods/${encodeURIComponent(methodId)}`);
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
   * caller supplies the method closure as inline `files` — for a stored method,
   * expand it first with `getMethodClosure` (requires an API key). See
   * `docs/input-preparation.md`.
   */
  async prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs> {
    return prepareInputsImpl(this, request);
  }

  /**
   * One PAGE of a method's runs, newest first — `GET /v1/runs?method_id=`.
   *
   * **This returns a page, not the whole history.** The API serves it from a
   * time-ordered index, so its cost is the page size rather than the size of
   * the history; a method with 100k runs answers as fast as one with 50. To
   * read further, pass the previous response's `nextCursor` back as
   * `query.cursor` until it comes back `null`.
   *
   * Breaking in v0.10.0: this used to return `PipelineRun[]` — the complete
   * history in one array. Code that rendered that array directly should now
   * either read `page.items` (accepting the first page) or follow the cursor.
   * `iterateRuns` does the latter for you.
   *
   * `createdFrom` / `createdTo` are applied server-side as index key
   * conditions, so a bounded page genuinely reads less. They are INSTANTS,
   * not days — see `ListRunsQuery`.
   */
  async listRuns(methodId: string, query: ListRunsQuery = {}): Promise<RunPage> {
    const params = new URLSearchParams({ method_id: methodId });
    // `!== undefined`, not truthiness: omission means "the caller did not ask
    // for this bound". An explicitly supplied empty string is not omission, it
    // is bad input — dropping it turned a broken date into a silently
    // UNFILTERED query returning every run, which reads as working. Forwarded,
    // it reaches the API's instant parse and comes back a 400 saying so.
    if (query.createdFrom !== undefined) params.set("created_from", query.createdFrom);
    if (query.createdTo !== undefined) params.set("created_to", query.createdTo);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const page = await this.requestProduct<{ items: PipelineRun[]; next_cursor: string | null }>(
      "GET",
      `runs?${params.toString()}`,
    );
    return { items: page.items, nextCursor: page.next_cursor };
  }

  /**
   * Every run of a method, streamed — follows the cursor for you.
   *
   * ```ts
   * for await (const run of client.iterateRuns(methodId)) {
   *   if (isTheOne(run)) break;   // stop whenever you like
   * }
   * ```
   *
   * **Prefer `listRuns`** for anything user-facing: this is O(history) by
   * construction and makes as many round trips as the data demands.
   *
   * An iterator rather than a `listAllRuns(): Promise<PipelineRun[]>`, and that
   * is not stylistic. An all-at-once helper needs a page cap so a misbehaving
   * server cannot spin it forever — and a cap means it returns a TRUNCATED list
   * with no error and no flag, a method with 6,000 runs quietly yielding 5,000.
   * Silently returning less than everything, from a method called "all", is the
   * exact failure mode paging was introduced to remove. Streaming has no such
   * cliff: it yields until the server says there is no more, the caller decides
   * when to stop, and only one page is ever in memory. If you truly want an
   * array, `Array.fromAsync` makes that your explicit choice.
   */
  async *iterateRuns(
    methodId: string,
    query: Omit<ListRunsQuery, "cursor"> = {},
  ): AsyncGenerator<PipelineRun, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page: RunPage = await this.listRuns(methodId, { ...query, cursor });

      // Checked BEFORE yielding. A server handing back the very cursor we sent
      // has not advanced, so this page repeats rows already emitted — yielding
      // first and stopping after would silently double-count them for anyone
      // aggregating the stream (summing cost, counting runs). Cannot fire on
      // the first request, where `cursor` is undefined.
      if (cursor !== undefined && page.nextCursor === cursor) return;

      for (const run of page.items) yield run;

      // Checked AFTER: `nextCursor === null` is the NORMAL end of the history
      // and that page is real data, so it has to be emitted first. The empty
      // page catches a server that keeps minting fresh cursors while returning
      // nothing, which would otherwise spin forever yielding nothing.
      //
      // Neither of these is a page cap. Both fire only on a server that is not
      // making progress, so neither can truncate a healthy stream the way a
      // `maxPages` limit silently did.
      if (page.nextCursor === null || page.items.length === 0) return;
      cursor = page.nextCursor;
    }
  }

  /**
   * The whole record for one run — `GET /v1/runs/{id}`.
   *
   * The ONLY call that returns `mthds_contents` (what the run actually
   * executed) and `inputs`. Kept off the status read, which pollers hit every
   * few seconds.
   */
  async getRunDetail(runId: string): Promise<RunDetail> {
    return this.requestProduct("GET", `runs/${encodeURIComponent(runId)}`);
  }

  /** Patch a run's status (admin/manual) — `PUT /v1/runs/{id}`. */
  async updateRun(runId: string, input: UpdateRunInput): Promise<void> {
    await this.requestProduct("PUT", `runs/${encodeURIComponent(runId)}`, input);
  }

  /**
   * Blocking `POST /v1/execute` adapted onto `RunResults` — the bare-runner
   * path. Forwards every protocol field PLUS every extension surface: the
   * runner-resolved `method_ref`, the hosted `method_id`, and the generic
   * `extra` passthrough. An extension-only call (`{ extra }` with no
   * pipe_code/bundle) or a vendor selector riding `extra` must survive this
   * path, not just the durable one — a `method_ref` run must run the same
   * fetched package here, and a hosted `method_id` must reach the server too,
   * so a runner that cannot resolve it says so (Rule 4) instead of the client
   * silently dropping it.
   */
  private async executeBlocking(options: PipelexStartOptions): Promise<RunResults> {
    const response = await this.execute({
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      // The bundle must survive the fallback too — a bare runner reached through
      // this path runs the same method as the durable one, or it runs nothing.
      files: options.files ?? undefined,
      bundle_b64: options.bundle_b64 ?? undefined,
      method_ref: options.method_ref ?? undefined,
      method_id: options.method_id ?? undefined,
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
// `files` / `bundle_b64` are reserved too: they are named run-source options,
// so smuggling them through `extra` (which merges last into the body) would
// overwrite the validated fields and bypass the run-source exclusivity check.
const PROTOCOL_REQUEST_KEYS: readonly string[] = [
  "pipe_code",
  "mthds_contents",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
  "files",
  "bundle_b64",
];

// The PIPELEX API's own request fields — the layer-2 extension the runner
// resolves itself (`method_ref`, a run source in its own right). Reserved on
// `extra` for the same reason the protocol fields are: `extra` merges last, so
// a smuggled copy would overwrite the validated named option and bypass the
// selector-exclusivity checks.
const PIPELEX_API_REQUEST_KEYS: readonly string[] = ["method_ref"];

// The HOSTED API's own request fields — the layer-3 extensions this client
// names itself. Reserved on `extra` for the same reason the protocol fields
// are: `extra` merges last, so a smuggled copy would overwrite the validated
// named option and arrive by a second path with different validation.
//
// The guard is deliberately PER LAYER. It lives here, in the hosted client,
// and must never be pushed down into the protocol clients (`mthds` /
// `mthds-python`): a layer that does not own an argument has no business
// rejecting it — a protocol client talking to some other vendor's server must
// keep passing that vendor's `method_id` straight through. That per-layer
// split is normative for the whole layered client stack.
const HOSTED_REQUEST_KEYS: readonly string[] = ["method_id"];

// Keys that must never ride `extra`: the named request options above (which
// `extra` would overwrite — it merges last into the body) plus the client-only
// `bundleMain` hint, which is documented as never-serialized and so must not
// reach the wire through the passthrough either.
const RESERVED_EXTRA_KEYS: ReadonlySet<string> = new Set([
  ...PROTOCOL_REQUEST_KEYS,
  ...PIPELEX_API_REQUEST_KEYS,
  ...HOSTED_REQUEST_KEYS,
  "bundleMain",
]);

// Prototype-pollution vectors. An own `__proto__` (exactly what `JSON.parse`
// yields, and `extra` is the field most likely populated from untrusted JSON),
// `constructor`, or `prototype` copied onto the body would make this client a
// pollution carrier for any JS hop that later deep-merges the parsed request —
// so they are stripped, never forwarded.
const POLLUTION_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate and copy the generic `extra` passthrough. Extension args ride the
 * request body as top-level properties; reserved request options (protocol
 * args, run sources, the client-only `bundleMain` hint) must be passed as named
 * options, never smuggled through `extra`.
 */
function buildExtensions(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  // Snapshot once, then validate and copy the snapshot — reading `extra` twice
  // (e.g. a `Proxy` whose `ownKeys` trap answers differently per call) could
  // otherwise let a reserved key pass the check yet reach the copy.
  const snapshot = { ...extra };
  const reserved = Object.keys(snapshot).filter((key) => RESERVED_EXTRA_KEYS.has(key));
  if (reserved.length > 0) {
    throw new PipelineRequestError(
      `extra carries reserved request args [${reserved.sort().join(", ")}] — pass them as named options instead.`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!POLLUTION_KEYS.has(key)) result[key] = value;
  }
  return result;
}

// `method_ref` resolution can make the server CLONE a repository before it
// answers, and the server-side clone timeout runs well past the 30s static-route
// budget on a cold cache. This budget covers that without touching the static
// routes' no-transport-options policy (see the note on `requestExtension`): it
// is an internal budget matched to what the server actually does, not a new
// caller-facing parameter — and inert on the hosted path, where the gateway
// caps responses regardless.
const METHOD_REF_FETCH_TIMEOUT_MS = 180_000; // 3 min — covers the server's clone + resolve

/**
 * The internal request budget for a call carrying a `CrateRequestBase` closure
 * (the crate routes and the build projections alike): the static-route default,
 * unless the closure is a `method_ref` the server may have to fetch first.
 * `buildRunner` is the exception — its own five-minute default already clears
 * the fetch budget.
 */
function crateRequestTimeoutMs(request: CrateRequestBase): number | undefined {
  return nonEmptyString(request.method_ref) !== undefined ? METHOD_REF_FETCH_TIMEOUT_MS : undefined;
}

/**
 * Copy the Pipelex API's own run arguments onto the wire body. Named options,
 * not `extra` entries — see `PipelexApiRunExtensions`. Same emptiness rule as
 * the hosted builder below: an absent or empty `method_ref` yields an empty
 * object, so the key is not sent and does not count towards the "something to
 * run" precondition.
 */
function buildApiRunExtensions(options: PipelexApiRunExtensions): Record<string, unknown> {
  const methodRef = nonEmptyString(options.method_ref);
  return methodRef === undefined ? {} : { method_ref: methodRef };
}

/**
 * Copy the hosted API's own run arguments onto the wire body. Named options,
 * not `extra` entries — see `PipelexHostedRunExtensions`.
 *
 * An absent or empty `method_id` yields an empty object, so the key is simply
 * not sent: `method_id: ""` selects no method and carries no linkage, and
 * putting it on the wire would only make the server reject a request the client
 * already knows is empty. That emptiness also means it does not count towards
 * the "something to run" precondition, which reads this object's size.
 */
function buildHostedRunExtensions(options: PipelexHostedRunExtensions): Record<string, unknown> {
  const methodId = nonEmptyString(options.method_id);
  return methodId === undefined ? {} : { method_id: methodId };
}

/**
 * Enforce the run routes' `method_ref` exclusivity, mirroring the server's own
 * 422s so an illegal pairing fails before anything hits the wire. A
 * `method_ref` is a complete run source (the fetched package carries its
 * `.mthds` and its entry pipe), so it pairs with NOTHING: not with inline
 * `mthds_contents`, not with a method bundle, and not with the hosted
 * `method_id` — an address run has its own provenance and needs no linkage id.
 *
 * The one documented run-route exception is deliberately NOT here: inline
 * source + `method_id` stays legal (the inline source runs; the id demotes to
 * run-history linkage). `pipe_code` beside a `method_ref` is legal too — it
 * overrides the manifest's `main_pipe`. The wording of the first two errors
 * mirrors the server's validator; presence semantics match it as well
 * (`mthds_contents` counts when non-empty, a bundle encoding counts when the
 * key is present, the selectors count when non-empty).
 */
function assertMethodRefPairsWithNothing(
  options: PipelexApiRunExtensions & PipelexHostedRunExtensions & RunRequest,
): void {
  if (nonEmptyString(options.method_ref) === undefined) return;
  if (options.mthds_contents != null && options.mthds_contents.length > 0) {
    throw new PipelineRequestError(
      "method_ref and inline mthds_contents are mutually exclusive; send one or the other.",
    );
  }
  if (options.files != null || options.bundle_b64 != null) {
    throw new PipelineRequestError(
      "method_ref and a method bundle (bundle_b64 / files) are mutually exclusive; send one or the other.",
    );
  }
  if (nonEmptyString(options.method_id) !== undefined) {
    throw new PipelineRequestError(
      "method_ref and method_id are mutually exclusive: an address run carries its own provenance " +
        "and takes no run-history linkage id. Send exactly one method selector.",
    );
  }
}

/**
 * Normalize a bundle encoding for the wire: an empty map / string is NOT a
 * runnable bundle, so it must not be sent (the runner rejects a zero-file
 * bundle). Exclusivity is still checked on presence upstream, so an empty
 * encoding supplied alongside another source has already been rejected.
 */
function nonEmptyFiles(
  files: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  return files != null && Object.keys(files).length > 0 ? files : undefined;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined;
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

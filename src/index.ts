/**
 * `@pipelex/sdk` — TypeScript SDK for the Pipelex hosted API.
 *
 * One import source for consumers: this barrel re-exports the pure MTHDS Protocol
 * surface (from the `mthds/protocol` subpath) alongside the Pipelex product client
 * (`PipelexApiClient`), its wire models, the run-lifecycle types, and the typed
 * errors. Consumers should import everything they need from `@pipelex/sdk`.
 */

/** Package version. Kept in sync with `package.json` — enforced by `tests/index.test.ts`. */
export const SDK_VERSION = "0.1.4";

// ── Pure MTHDS Protocol surface (re-exported from the `mthds/protocol` subpath) ──
// The standard's interface, wire models, request/options surface, abstract domain
// shapes, and the protocol-base `PipelineRequestError`. Re-exported so apps have a
// single import source.
export * from "mthds/protocol";

// ── Pipelex product client ───────────────────────────────────────────
export { PipelexApiClient, DEFAULT_API_BASE_URL } from "./client.js";
export type { MthdsFile, ValidateFilesOptions, PipelexApiClientOptions } from "./client.js";

// ── Wire models (Dict concretes, validate surface, build routes) ─────
export type {
  DictStuff,
  DictWorkingMemory,
  DictPipeOutput,
  DictRunResultExecute,
  DryRunStatus,
  ValidatedPipeEntry,
  PipelexValidationReport,
  PipelexInvalidReport,
  PipelexValidationResult,
  ValidationErrorCategory,
  ValidationErrorItem,
  ConceptRepresentationFormat,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  ConceptRequest,
  PipeSpecRequest,
  BuildRunnerResponse,
  ConceptResponse,
  PipeSpecResponse,
} from "./models.js";

// ── Pipelex product surface (hosted management routes) ───────────────
export type {
  UserProfile,
  MethodData,
  MethodWriteInput,
  Membership,
  MembershipsResponse,
  SubscriptionResponse,
  PlanView,
  InvoiceView,
  CheckoutResponse,
  ChangePlanResponse,
  BillingPortalResponse,
  PipelexApiKey,
  PipelexApiKeyCreated,
  PipelexApiKeyList,
  GatewayApiKey,
  GatewayApiKeyStatus,
  OnboardingRole,
  OnboardingCurrentTool,
  OnboardingInputType,
  OnboardingHeardFrom,
  OnboardingSubmission,
  ResolvedStorageUrl,
  UploadInput,
  UploadedFile,
  PipeStatus,
  PipelineRun,
  UpdateRunInput,
} from "./product-models.js";

// ── Run lifecycle (hosted extension — NOT part of the protocol) ──────
export { isTerminalRunStatus, isSuccessRunStatus } from "./runs.js";
export type {
  RunStatus,
  RunPublic,
  RunRead,
  RunResults,
  RunResultState,
  WaitForResultOptions,
} from "./runs.js";

// ── Typed errors (PipelineRequestError rides the protocol re-export above) ──
export {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineExecuteTimeoutError,
  RunFailedError,
  RunTimeoutError,
  RunStillRunningError,
  RunLifecycleUnavailableError,
} from "./errors.js";

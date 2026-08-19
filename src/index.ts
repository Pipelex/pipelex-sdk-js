/**
 * `@pipelex/sdk` — TypeScript SDK for the Pipelex hosted API.
 *
 * One import source for consumers: this barrel re-exports the pure MTHDS Protocol
 * surface (from the `mthds/protocol` subpath) alongside the Pipelex product client
 * (`PipelexApiClient`), its wire models, the run-lifecycle types, and the typed
 * errors. Consumers should import everything they need from `@pipelex/sdk`.
 */

/** Package version. Kept in sync with `package.json` — enforced by `tests/index.test.ts`. */
export const SDK_VERSION = "0.11.0";

// ── Pure MTHDS Protocol surface (re-exported from the `mthds/protocol` subpath) ──
// The standard's interface, wire models, request/options surface, abstract domain
// shapes, and the protocol-base `PipelineRequestError`. Re-exported so apps have a
// single import source.
export * from "mthds/protocol";

// ── Pipelex product client ───────────────────────────────────────────
export { PipelexApiClient, DEFAULT_API_BASE_URL } from "./client.js";
export type {
  MthdsFile,
  BuildInputsByMethodId,
  ValidateFilesOptions,
  PipelexApiClientOptions,
} from "./client.js";

// Canonical parser: a stored method's polymorphic `MethodData.mthds` source → bundle contents.
export { methodSourceToContents } from "./method-source.js";

// The blocking `execute()` result — a `DictRunResultExecute` with a resolved `.main_stuff`.
export { PipelexExecuteResult } from "./execute-result.js";

// ── Input preparation (client.uploadFile / client.prepareInputs — hosted upload capability) ──
// The operations are client methods; only their public types travel with the barrel.
export type { UploadableAsset, UploadFileOptions, UploadRecord } from "./upload.js";
export type { PrepareInputsRequest, PreparedInputs } from "./prepare-inputs.js";

// ── Wire models (Dict concretes, validate surface, tools + build + crate routes) ──
export type {
  DiagnosticKind,
  DiagnosticRange,
  Diagnostic,
  LintResponse,
  FormatResponse,
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
  InputsTemplateFormat,
  MthdsFileItem,
  CrateRequestBase,
  BuildRequestBase,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  ConceptRequest,
  PipeSpecRequest,
  CrateInvalidReport,
  BuildInputsValidReport,
  BuildOutputValidReport,
  BuildRunnerValidReport,
  GeneratedArtifact,
  RunnerStructures,
  BuildInputsResponse,
  BuildOutputResponse,
  BuildRunnerResponse,
  ConceptResponse,
  PipeSpecResponse,
  ResolveRequest,
  ResolveValidReport,
  ResolveResponse,
  CodegenKind,
  CodegenTarget,
  CodegenRequest,
  CodegenValidReport,
  CodegenResponse,
} from "./models.js";

// ── Pipelex product surface (hosted management routes) ───────────────
export type {
  UserProfile,
  ListMethodsQuery,
  MethodData,
  MethodDeletionState,
  MethodPage,
  MethodSummary,
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
  ListRunsQuery,
  PipelineRun,
  RunDetail,
  RunErrorReport,
  RunPage,
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
  TokensUsageRecord,
  WaitForResultOptions,
} from "./runs.js";

// ── Typed errors (PipelineRequestError rides the protocol re-export above) ──
export {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  MissingMainStuffError,
  PipelineExecuteTimeoutError,
  RunFailedError,
  RunTimeoutError,
  RunStillRunningError,
  RunLifecycleUnavailableError,
  InputPreparationError,
  EmptyMethodSourceError,
  InvalidLocalSourceError,
  RejectedAssetError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "./errors.js";

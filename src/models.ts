/**
 * Pipelex wire models — the concrete JSON shapes `PipelexApiClient` deals in.
 *
 * Holds the Dict-serialized protocol concretes (`DictStuff` / `DictWorkingMemory`
 * / `DictPipeOutput` and the default `RunResultExecute` binding), the Pipelex
 * `/v1/validate` surface (`PipelexValidationResult` + `ValidationErrorItem`), and
 * the `/v1/build/*` request/response models. Built on the protocol wire types
 * imported from the `mthds/protocol` subpath.
 */

import type { InvalidValidationReport, RunResultExecute, ValidationReport } from "mthds/protocol";

export interface DictStuff {
  concept: string;
  content: unknown;
}

export interface DictWorkingMemory {
  root: Record<string, DictStuff>;
  aliases: Record<string, string>;
}

/**
 * Serialized pipe output — mirror of python's `DictPipeOutputAbstract`
 * (`{working_memory, pipeline_run_id}`). NOTE: the inner `pipeline_run_id` is a
 * runtime-internal field produced by the pipelex runtime inside the
 * `pipe_output` payload — it deliberately keeps its name (runtime internals are
 * out of the wire-rename scope).
 */
export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  pipeline_run_id: string;
}

/**
 * The default `RunResultExecute` binding — the concrete execute result with a
 * Dict-serialized output. Extension fields (e.g. `main_stuff_name`) ride the
 * protocol's extension-open response.
 */
export type DictRunResultExecute = RunResultExecute<DictPipeOutput>;

// ── Validate surface (Pipelex-API extensions over the protocol) ──────────
//
// `POST /v1/validate` is a diagnostic endpoint: every produced verdict rides a
// 200, discriminated on `is_valid` (the protocol's `ValidationResult` union).
// The Pipelex API narrows both arms: the VALID arm is the canonical
// `PipelexValidationReport`; the INVALID arm is `PipelexInvalidReport`, carrying
// a structured `validation_errors[]` list. Non-2xx is reserved for no-verdict
// conditions (a malformed request, an `mthds_sources` length mismatch, auth, a
// server fault), surfaced as `ApiResponseError`.

/** Per-pipe dry-run verdict in `validated_pipes[]` — mirror of pipelex's `DryRunStatus`. */
export type DryRunStatus = "SUCCESS" | "FAILURE" | "SKIPPED";

/** One entry of `PipelexValidationReport.validated_pipes` — `{pipe_ref, status}`. */
export interface ValidatedPipeEntry {
  /** Namespaced `pipe_ref` (`domain.code`) — never the bare code. */
  pipe_ref: string;
  status: DryRunStatus;
}

/**
 * Pipelex's `POST /v1/validate` 200 body for a VALID bundle — the canonical
 * `PipelexValidationReport` (typed extension over the protocol's `ValidationReport`,
 * carrying its `is_valid: true` discriminant) plus the route's wire-only extras
 * (`message`, the `mthds_contents` echo). Field names follow the MTHDS brand
 * boundary — blueprints/graphs are language artifacts, so no `pipelex_` prefix
 * inside this envelope.
 *
 * `bundle_blueprint`, `pipe_io_contracts`, and `graph_spec` stay opaque transport
 * (`Record<string, unknown>` / `unknown`): their canonical schemas are owned
 * elsewhere (the runtime's blueprint models; `@pipelex/mthds-ui` owns `GraphSpec`).
 * Inherits the extension index signature, so any further server field is preserved.
 */
export interface PipelexValidationReport extends ValidationReport {
  /** The batch's primary blueprint (first declaring `main_pipe`, else first). */
  bundle_blueprint: Record<string, unknown>;
  /** Per-pipe input/output contracts, keyed by namespaced `pipe_ref` (`domain.code`). */
  pipe_io_contracts: Record<string, unknown>;
  /** Best-effort execution graph of the main pipe; `null` with no `main_pipe` or on degrade. */
  graph_spec: unknown;
  /** Per-pipe dry-run sweep outcomes. */
  validated_pipes: ValidatedPipeEntry[];
  /** Qualified refs of pipes still declared as `PipeSignature`. */
  pending_signatures: string[];
  /** `not pending_signatures` — whether the validated library is complete enough to run. */
  is_runnable: boolean;
  /** Route extra: status message. */
  message: string;
  /** Route extra: echo of the submitted `mthds_contents`. */
  mthds_contents?: string[];
  /**
   * Opt-in Pipelex-API presentation extra: the server-rendered Markdown view of the
   * verdict, present only when the request asked for it (`render: ["markdown"]`).
   * Absent by default. Rendered once server-side by pipelex's shared renderer, so it
   * matches the local CLI's `--format markdown` output in format/structure.
   */
  rendered_markdown?: string;
}

/**
 * Pipelex's `POST /v1/validate` 200 body for an INVALID bundle — the `is_valid: false`
 * arm of the response union, narrowing the protocol's `InvalidValidationReport` to the
 * closed-vocabulary `ValidationErrorItem[]`. The structural artifacts of the valid arm
 * are absent (they don't exist when load/parse/wiring failed); `validation_errors[]` is
 * non-empty on every invalid verdict (the structured-info invariant — even a parse-level
 * failure carries one source-less `blueprint_validation` residual).
 */
export interface PipelexInvalidReport extends InvalidValidationReport {
  /** Structured per-error diagnostics, built by pipelex's one shared builder. */
  validation_errors: ValidationErrorItem[];
  /**
   * Opt-in Pipelex-API presentation extra: the server-rendered Markdown view of the
   * invalid verdict (`# Validation failed` + the `validation_errors`), present only
   * when the request asked for it (`render: ["markdown"]`). Absent by default.
   */
  rendered_markdown?: string;
}

/**
 * The Pipelex `POST /v1/validate` 200 response — the discriminated union the
 * `PipelexApiClient.validate` returns, keyed on `is_valid`. Narrows the protocol's
 * `ValidationResult` to Pipelex's typed arms.
 */
export type PipelexValidationResult = PipelexValidationReport | PipelexInvalidReport;

/**
 * Which validation stage produced a `ValidationErrorItem` — mirror of pipelex's
 * closed `ValidationErrorCategory` set. `pipe_factory` and graph-level `dry_run`
 * items carry no `source`; map those by `domain_code` / `pipe_code`. The other
 * categories carry `source` when the runtime can attribute one.
 */
export type ValidationErrorCategory =
  "blueprint_validation" | "pipe_factory" | "pipe_validation" | "dry_run";

/**
 * One structured bundle-validation error — mirror of pipelex's `ValidationErrorItem`.
 * Carried by `PipelexInvalidReport.validation_errors[]` on the **200** invalid arm of
 * `POST /v1/validate` (NOT a 422 — an invalid bundle is a produced verdict). The same
 * typed item also rides the build routes' 422 problem bodies (`ApiResponseError.validationErrors`).
 *
 * Only `category` and `message` are always present; the rest are populated per
 * `category` and dropped from the wire when unset (`exclude_none` server-side).
 * `source` is the declaring file path (CLI) or the per-content `mthds_sources` name
 * the API threads onto the in-memory load path — the owning file for cross-file
 * diagnostics.
 */
export interface ValidationErrorItem {
  category: ValidationErrorCategory;
  message: string;
  error_type?: string;
  pipe_code?: string;
  concept_code?: string;
  domain_code?: string;
  source?: string;
  field_path?: string;
  field_name?: string;
  variable_names?: string[];
  missing_concept_code?: string;
  declared_concepts?: string[];
}

// ── Build routes (Pipelex API layer 2 — `/v1/build/*`) ──────────────────

export type ConceptRepresentationFormat = "json" | "python" | "schema";

export interface BuildInputsRequest {
  mthds_contents: string[];
  pipe_code: string;
}

export interface BuildOutputRequest {
  mthds_contents: string[];
  pipe_code: string;
  format?: ConceptRepresentationFormat;
}

export interface BuildRunnerRequest {
  mthds_contents: string[];
  pipe_code: string;
}

export interface ConceptRequest {
  spec: Record<string, unknown>;
}

export interface PipeSpecRequest {
  pipe_type: string;
  spec: Record<string, unknown>;
}

export interface BuildRunnerResponse {
  python_code: string;
  pipe_code: string;
  success: boolean;
  message: string;
}

export interface ConceptResponse {
  success: boolean;
  concept_code: string;
  toml: string;
}

export interface PipeSpecResponse {
  success: boolean;
  pipe_code: string;
  pipe_type: string;
  toml: string;
}

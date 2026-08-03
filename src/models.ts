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
 *
 * **Extension-open**, mirroring `DictPipeOutputAbstract`'s `extra="allow"`: the
 * runner rides Pipelex extension fields here beside `working_memory` — the usage
 * pair (`tokens_usages` / `usage_assembly_error`) is the current example. Without
 * the index signature, reading one means casting the whole value away, and the
 * two SDK mirrors of the same wire shape disagree on whether it is closed.
 */
export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  pipeline_run_id: string;
  /** Pipelex extension fields the runner rides on the pipe output. */
  [extension: string]: unknown;
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

// ── Tools routes (Pipelex API — `/v1/lint`, `/v1/format`) ───────────────
//
// Both are diagnostic endpoints over a SINGLE `.mthds` file: malformed content is
// a produced verdict on a **200** (`diagnostics[]`), never a thrown error. Non-2xx
// is reserved for no-verdict conditions (a malformed body, bad formatter options,
// auth, a server fault), surfaced as `ApiResponseError`.

/** Which analysis produced a `Diagnostic` — mirror of `pipelex-tools`' closed kind set. */
export type DiagnosticKind = "syntax" | "semantic" | "schema";

/** Source span of a `Diagnostic` — byte offsets plus 1-based line/column coordinates. */
export interface DiagnosticRange {
  start_offset: number;
  end_offset: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

/**
 * One structured lint/format diagnostic — mirror of pipelex's `Diagnostic`.
 * `severity` stays an open string (the server does not close the vocabulary);
 * `location` and `range` are `null` when the analysis cannot attribute a span.
 */
export interface Diagnostic {
  kind: DiagnosticKind;
  severity: string;
  message: string;
  location: string | null;
  range: DiagnosticRange | null;
}

/** `POST /v1/lint` 200 body — the diagnostics of one linted `.mthds` file. */
export interface LintResponse {
  diagnostics: Diagnostic[];
}

/**
 * `POST /v1/format` 200 body — the canonically formatted content, whether it
 * differs from the submitted one, and any diagnostics found on the way. A syntax
 * error yields `changed: false` with the content echoed back unchanged.
 */
export interface FormatResponse {
  formatted: string;
  changed: boolean;
  diagnostics: Diagnostic[];
}

// ── Build routes (Pipelex API layer 2 — `/v1/build/*`) ──────────────────

export type ConceptRepresentationFormat = "json" | "python" | "schema";

/** Encoding of a `/v1/build/inputs` template. Decides which field carries it back. */
export type InputsTemplateFormat = "json" | "toml";

/**
 * One MTHDS file in a build closure. `source` is an optional provenance label (a
 * filename, a URI) that the server threads onto every diagnostic it raises from
 * this file, so an invalid verdict can point at the file that caused it.
 *
 * NOT the same type as `MthdsFile` (the one `validateFiles()` takes), which the
 * client adapts into `/v1/validate`'s parallel `mthds_contents` + `mthds_sources`
 * arrays: that route spells the label `uri`, this envelope spells it `source`. The
 * two collapse into one only if `/v1/validate` ever migrates onto `files[]` — a
 * protocol-level change owned by the MTHDS standard, not ours to make here.
 */
export interface MthdsFileItem {
  content: string;
  source?: string;
}

/**
 * The closure selector every crate-family route shares — `/v1/resolve`, `/v1/codegen`,
 * and `/v1/build/*` (mirror of the server's `MthdsFilesRequest`).
 *
 * Supply the closure EITHER as inline `files` OR as a `method_ref` into the method
 * registry — never both, and never neither (both arms are a request-shape `422`).
 * `method_ref` is reserved: the registry does not exist yet, so the server answers
 * `501` for it today.
 *
 * The XOR is a server-side invariant, not a type-level one: expressing it as a union
 * here would make the common `{ files }` call site pick a branch for no gain, and the
 * server rejects the two illegal shapes with a typed `ApiResponseError` either way.
 */
export interface CrateRequestBase {
  files?: MthdsFileItem[];
  method_ref?: string;
}

/**
 * The crate envelope plus the pipe selector the `/v1/build/*` projections add
 * (mirror of the server's `MthdsPipeRequest`).
 */
export interface BuildRequestBase extends CrateRequestBase {
  /**
   * The pipe to project, as a QUALIFIED `domain.pipe_code` ref. Omit it to default
   * to the closure's declared `main_pipe` — which fails (422) when the closure
   * declares none, or declares several across its domains.
   */
  pipe_ref?: string;
}

export interface BuildInputsRequest extends BuildRequestBase {
  /**
   * `method_id` (the by-id closure alternative) is a separate client param type,
   * never a field of the inline-`files` request. Pinned to `never` so an
   * over-specified `{ files, method_id }` request is a compile error — mirroring
   * `PrepareInputsRequest`'s discriminated union. The runtime `buildInputs` guard
   * backs this for untyped (JS) callers.
   */
  method_id?: never;
  /** `json` (default) puts the parsed template in `inputs`; `toml` puts raw text in `inputs_toml`. */
  format?: InputsTemplateFormat;
  /** Emit the ceremonial `{concept, content}` envelope per input. Defaults to the light shape. */
  explicit?: boolean;
}

export interface BuildOutputRequest extends BuildRequestBase {
  /** `schema` (default) and `json` put a parsed object in `output`; `python` puts source in `output_python`. */
  format?: ConceptRepresentationFormat;
}

export interface BuildRunnerRequest extends BuildRequestBase {
  /**
   * Accept unresolved pipe signatures as pending rather than invalid. Alone among
   * the build routes this one still runs the dry-run sweep, and the flag only ever
   * parameterized that sweep.
   */
  allow_signatures?: boolean;
}

export interface ConceptRequest {
  spec: Record<string, unknown>;
}

export interface PipeSpecRequest {
  pipe_type: string;
  spec: Record<string, unknown>;
}

/**
 * The `is_valid: false` arm shared by every crate-family route — `/v1/build/*`,
 * `/v1/resolve`, and `/v1/codegen` (mirror of the server's one `CrateInvalidReport`).
 *
 * They all follow `/validate`'s discipline: an unresolvable closure is the
 * *successful product* of the call (the request was well-formed, the library was
 * not), so it rides a **200** discriminated on `is_valid` — never a 4xx. Only a
 * no-verdict condition throws `ApiResponseError`: a request the route cannot act on
 * (an unknown `pipe_ref` on the build routes, an unknown `kind`/`target` on codegen),
 * the reserved `method_ref`, auth, a server fault. Branch on `is_valid`, never on the
 * transport.
 */
export interface CrateInvalidReport {
  is_valid: false;
  validation_errors: ValidationErrorItem[];
  message: string;
}

/** Fields the valid arm of every `/v1/build/*` route carries. */
interface BuildValidReportBase {
  is_valid: true;
  /** The qualified pipe that was projected — the RESOLVED selector, always `domain.pipe_code`. */
  pipe_ref: string;
  /** The `pipe_ref` as submitted. Absent when it was omitted and defaulted to `main_pipe`. */
  requested_pipe_ref?: string;
  message: string;
}

/**
 * The `/v1/build/inputs` valid arm. The template rides ONE of two fields, chosen by
 * `format`: `inputs` (a parsed object) for `json`, `inputs_toml` (raw text) for
 * `toml`. TOML cannot be carried as a parsed object without losing what makes it
 * worth asking for — its concept comments and key order — so the two are separate
 * fields and the unused one is absent from the body entirely.
 *
 * That "absent entirely" is why this is a union rather than one interface with two
 * optional fields: `format` is a real discriminant, so narrowing on it hands you the
 * field it selected as REQUIRED, with the other one statically unreachable.
 */
interface BuildInputsJsonReport extends BuildValidReportBase {
  format: "json";
  explicit: boolean;
  inputs: Record<string, unknown>;
  inputs_toml?: never;
}

interface BuildInputsTomlReport extends BuildValidReportBase {
  format: "toml";
  explicit: boolean;
  inputs?: never;
  inputs_toml: string;
}

export type BuildInputsValidReport = BuildInputsJsonReport | BuildInputsTomlReport;

export type BuildInputsResponse = BuildInputsValidReport | CrateInvalidReport;

/**
 * The `/v1/build/output` valid arm. Same two-field split as the inputs template, for
 * the same reason: `schema` and `json` are objects, `python` is source text — and so
 * it is a discriminated union for the same reason too.
 */
interface BuildOutputObjectReport extends BuildValidReportBase {
  format: "schema" | "json";
  output: Record<string, unknown>;
  output_python?: never;
}

interface BuildOutputPythonReport extends BuildValidReportBase {
  format: "python";
  output?: never;
  output_python: string;
}

export type BuildOutputValidReport = BuildOutputObjectReport | BuildOutputPythonReport;

export type BuildOutputResponse = BuildOutputValidReport | CrateInvalidReport;

/**
 * One stamped generated file — shared by `/v1/build/runner`'s structures projection
 * and `/v1/codegen`'s artifact set. `path` is relative to the output root the client
 * chooses; `content` is complete, stamp header included, and is written verbatim.
 */
export interface GeneratedArtifact {
  path: string;
  content: string;
}

/**
 * The typed-structures projection the runner script imports from. Write `artifacts`
 * and `lock` (as `lock_filename`) under `directory`, relative to the runner script,
 * and the returned `python_code` runs against them.
 */
export interface RunnerStructures {
  directory: string;
  artifacts: GeneratedArtifact[];
  lock: string;
  lock_filename: string;
}

export interface BuildRunnerValidReport extends BuildValidReportBase {
  python_code: string;
  structures: RunnerStructures;
}

export type BuildRunnerResponse = BuildRunnerValidReport | CrateInvalidReport;

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

// ── Crate extensions (Pipelex API — `/v1/resolve`, `/v1/codegen`) ───────
//
// The second crate-family surface: `/v1/resolve` emits the normalized library crate,
// `/v1/codegen` projects that crate into stamped typed artifacts plus their lock.
// Both are Pipelex API extensions (NOT `x-mthds-protocol`) over the standard-owned
// artifact, so their wire fields stay brand-neutral. Same envelope and same verdict
// discipline as the build routes: a produced verdict is a 200 discriminated on
// `is_valid`, with `CrateInvalidReport` as the shared invalid arm.

/** `POST /v1/resolve` request — the bare crate envelope, no projection axes. */
export type ResolveRequest = CrateRequestBase;

/**
 * The `/v1/resolve` valid arm — the normalized library crate.
 *
 * `crate` is the canonical JSON encoding of the MTHDS **Library Crate Format**: fully
 * qualified refs, refinement flattened, natives materialized, top-level maps key-sorted,
 * non-semantic provenance dropped. Its `fingerprint` and `mthds_version` ride INSIDE the
 * payload, not beside it, so a fingerprint computed from this object agrees with one
 * computed from `pipelex resolve --format json`.
 *
 * Typed as opaque transport (`Record<string, unknown>`): the crate schema is owned by the
 * MTHDS standard, not by this SDK, and restating it here would be a second source of truth
 * free to drift from the one the server emits.
 */
export interface ResolveValidReport {
  is_valid: true;
  crate: Record<string, unknown>;
  message: string;
}

/** The `POST /v1/resolve` 200 response — pattern-match `is_valid` before reading the arm. */
export type ResolveResponse = ResolveValidReport | CrateInvalidReport;

/**
 * What `/v1/codegen` projects — the `kind` axis. `types` (the crate's whole concept set
 * projected into typed models) is the only kind served today; the future per-pipe kinds
 * (`docs`, `tools`, `tests`) join it and select their pipe via `pipe_ref`. Input templates
 * are deliberately NOT a kind here — they are user-editable scaffolds, never stamped or
 * locked, and ride `POST /v1/build/inputs` instead.
 */
export type CodegenKind = "types";

/**
 * For whom `/v1/codegen` projects — the `target` axis, mirroring pipelex's `CodegenTarget`.
 * `ts-zod` (zod schemas + inferred types) is the natural target for TypeScript consumers;
 * `python-pydantic` emits self-contained BaseModels; `python-structures` emits runtime
 * StructuredContent classes for a Pipelex host.
 */
export type CodegenTarget = "ts-zod" | "python-pydantic" | "python-structures";

/** `POST /v1/codegen` request — the crate envelope plus the two explicit projection axes. */
export interface CodegenRequest extends CrateRequestBase {
  kind: CodegenKind;
  target: CodegenTarget;
  /**
   * Pipe selector for per-pipe projection kinds. `kind: "types"` is concept-set-wide and
   * REJECTS it with a request-shape `422` rather than silently ignoring it — the field
   * exists for the future per-pipe kinds.
   */
  pipe_ref?: string;
}

/**
 * The `/v1/codegen` valid arm — the stamped artifact set plus its lock.
 *
 * The trust chain: write every `artifacts[]` entry at its `path` and the `lock` content as
 * `lock_filename`, both verbatim, and the tree is byte-identical to what a local `pipelex
 * codegen types` run produces — same stamps, same lock — so the offline `pipelex codegen
 * check` passes on it. Editing an artifact (or re-serializing the lock) breaks that chain;
 * there is deliberately no server-side check route, because the check is offline by design.
 */
export interface CodegenValidReport {
  is_valid: true;
  /** Echo of the request's projection axes. */
  kind: CodegenKind;
  target: CodegenTarget;
  /** Fingerprint of the normalized crate the artifacts were generated from. */
  crate_fingerprint: string;
  /** The pipelex engine version that generated them. */
  engine_version: string;
  artifacts: GeneratedArtifact[];
  /** The lock file's TOML content — write verbatim beside the artifacts. */
  lock: string;
  /** The filename `lock` must be written as (`codegen.lock`). */
  lock_filename: string;
  message: string;
}

/** The `POST /v1/codegen` 200 response — pattern-match `is_valid` before reading the arm. */
export type CodegenResponse = CodegenValidReport | CrateInvalidReport;

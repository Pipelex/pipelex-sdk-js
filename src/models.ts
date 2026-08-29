/**
 * Pipelex wire models — the concrete JSON shapes `PipelexApiClient` deals in.
 *
 * Holds the Dict-serialized protocol concretes (`DictStuff` / `DictWorkingMemory`
 * / `DictPipeOutput` and the default `RunResultExecute` binding), the Pipelex
 * `/v1/validate` surface (`PipelexValidationResult` + `ValidationErrorItem`), and
 * the `/v1/build/*` request/response models. Built on the protocol wire types
 * imported from the `mthds/protocol` subpath.
 */

import type {
  InputForm,
  InvalidValidationReport,
  PipeIOContracts,
  RunResultExecute,
  RunResultStart,
  ValidationReport,
} from "mthds/protocol";

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

// ── Method-selector extensions (address form + hosted catalog id) ────────
//
// A method reaches any method-taking route in one of three forms: inline source
// (the protocol's `mthds_contents` / the bundle encodings), a `method_ref`
// address (`github.com/<owner>/<repo>[/<selector>][@<tag>]` — a Pipelex-API
// extension, resolved by the RUNNER via git fetch at the tag), or a `method_id`
// catalog id (`mt_…` — a hosted-platform extension, resolved against the org's
// catalog; an open-source runner has no catalog and answers a 422 naming the
// key). The two selectors never meet in the runner: the platform resolves
// `method_id` into inline source before any runner sees the request.

/**
 * Provenance of a `method_ref` run — the package's resolved full address, the
 * requested tag (`null` for a bare address, which resolves the default branch
 * at HEAD), and the commit SHA that was actually fetched. The SHA is what keeps
 * the run explainable when a tag moves. A Pipelex-API extension; attached to
 * the start ack and the execute response for `method_ref` runs, absent (or
 * `null`) otherwise.
 */
export interface MethodProvenance {
  address: string;
  tag: string | null;
  commit_sha: string;
}

/**
 * The `POST /v1/start` 202 ack as the Pipelex API returns it — the protocol's
 * `RunResultStart` plus the server's `method_provenance` extension, populated
 * for `method_ref` runs and absent or `null` otherwise.
 */
export interface PipelexRunResultStart extends RunResultStart {
  method_provenance?: MethodProvenance | null;
}

/**
 * The hosted tooling routes' own selector — the layer-3 extension the platform
 * adds on `POST /v1/validate`, `/v1/resolve`, and `/v1/codegen`: a stored
 * method's catalog id (`mt_…`), resolved server-side against the org's catalog
 * and injected as inline source before the runner sees the request. A **pass-
 * through to the hosted API**: nothing is expanded client-side, and it is
 * meaningless off-platform (a bare runner rejects the request as carrying no
 * source it understands).
 *
 * The tooling routes are stateless, so there is no linkage exception: exactly
 * one of inline source / `method_ref` / `method_id` per request — any second
 * selector is a request-shape `422`. An unknown or foreign-org id is a `404`
 * (indistinguishable by design); a stored method with no MTHDS source is a
 * `422`. The `/v1/build/*` projections are deliberately excluded — they take
 * no `method_id` (expand a stored method with `getMethodClosure` there).
 */
export interface PipelexHostedToolingExtensions {
  /** A stored method's catalog id (`mt_…`) — hosted-only, resolved server-side. */
  method_id?: string;
}

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
 * One entry of `PipelexValidationReport.liftable_pipes` — mirror of pipelex's
 * `LiftablePipeEntry`. A pipe the runtime may skip (lift) when an optional slot
 * resolves absent: build-time visibility for "this step may not run", derived by
 * the absence-taint pass, not a verdict.
 */
export interface LiftablePipeEntry {
  /** Namespaced ref of the liftable pipe. */
  pipe_ref: string;
  /** Namespaced ref of the controller in whose flow the lift happens. */
  within_pipe_ref: string;
  /** The slot names whose absence lifts the pipe. */
  skipped_when_absent: string[];
  /** Where the possible absence originates (human-readable). */
  absence_source: string;
}

/**
 * Pipelex's `POST /v1/validate` 200 body for a VALID bundle — the canonical
 * `PipelexValidationReport` (typed extension over the protocol's `ValidationReport`,
 * carrying its `is_valid: true` discriminant) plus the route's wire-only extras
 * (`message`, the `mthds_contents` echo). Field names follow the MTHDS brand
 * boundary — blueprints/graphs are language artifacts, so no `pipelex_` prefix
 * inside this envelope.
 *
 * This SDK owns none of the artifacts the envelope carries, and it narrows the two the
 * MTHDS standard has declared in the one way that keeps that true: by **importing** the
 * standard's own types. `pipe_io_contracts` and `input_form` are `PipeIOContracts` and
 * `InputForm` from `mthds/protocol`, the recommended extension fields of the protocol's
 * validation report, declared once per language and re-exported unchanged through this
 * package's barrel. Nothing about their shape is restated here, so there is no second
 * source of truth free to drift from the one the server emits — which is precisely what
 * the earlier ruling that kept both opaque was protecting against. Importing serves that
 * concern better than opacity did, and the principle it was defending is unchanged: this
 * envelope is transport, and the shapes it transports belong to the standard.
 *
 * `bundle_blueprint` and `graph_spec` do stay opaque transport (`Record<string, unknown>`
 * / `unknown`): their canonical schemas are owned elsewhere — the runtime's blueprint
 * models, and `@pipelex/mthds-ui`'s `GraphSpec` — and neither has a wire declaration in
 * the standard for this SDK to import. Each narrows on the day one exists.
 * Inherits the extension index signature, so any further server field is preserved.
 */
export interface PipelexValidationReport extends ValidationReport {
  /** The batch's primary blueprint (first declaring `main_pipe`, else first). */
  bundle_blueprint: Record<string, unknown>;
  /**
   * Per-pipe input/output contracts, keyed by namespaced `pipe_ref` (`domain.code`) —
   * the standard's `PipeIOContracts` artifact, imported rather than restated.
   */
  pipe_io_contracts: PipeIOContracts;
  /**
   * Per-pipe input-form descriptors — the standard's `InputForm` artifact, derived from
   * authored facts rather than the emitted JSON Schema, so a renderer can build a
   * fill-in form from the verdict alone. Keyed over the same `pipe_ref` set as
   * `pipe_io_contracts`, an invariant the imported type states for both.
   *
   * OPTIONAL on purpose: this is an opt-in structured view, requested through
   * `views: ["input_form"]` (see `validate`) and absent from any verdict that did not
   * ask for it. `pipelex-api` gates it on that token as of 0.18.0; 0.17.0 emitted it on
   * every valid verdict, the derivation having landed ahead of its carriage gate.
   *
   * Optional rather than narrowed by a `views`-generic overload on `validate`: presence
   * is a function of the request, and tying the type to a runtime array's contents costs
   * every caller a harder signature to read in exchange for one non-null assertion at the
   * single call site that opts in.
   */
  input_form?: InputForm;
  /** Pipes the runtime may skip when an optional slot resolves absent. */
  liftable_pipes: LiftablePipeEntry[];
  /** Best-effort execution graph of the main pipe; `null` with no `main_pipe` or on degrade. */
  graph_spec: unknown;
  /** Per-pipe dry-run sweep outcomes. */
  validated_pipes: ValidatedPipeEntry[];
  /**
   * Advisory lints on a VALID bundle — same item shape as `validation_errors[]`, so one
   * parser serves both channels, but these never flip `is_valid`. Empty when the bundle
   * is lint-free. Carries the advisory `hint_*` error types, which ride here exclusively.
   */
  warnings: ValidationErrorItem[];
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
 * `POST /v1/validate` (NOT a 422 — an invalid bundle is a produced verdict), by the
 * VALID arm's advisory `warnings[]`, and by the build routes' 422 problem bodies
 * (`ApiResponseError.validationErrors`).
 *
 * Only `category` and `message` are always present; the rest are populated per
 * `category`. Every other member is `?: T | null` because the two channels serialize
 * an unset locator differently: the invalid arm and the crate routes drop the key
 * (`exclude_none` server-side) while the valid arm — which carries `warnings[]` — does
 * not, so the same item arrives with explicit `null`s there. A truthiness check reads
 * both; an `=== undefined` check would be wrong on one of them.
 *
 * `source` is the declaring file path (CLI) or the per-content `mthds_sources` name
 * the API threads onto the in-memory load path — the owning file for cross-file
 * diagnostics.
 */
export interface ValidationErrorItem {
  category: ValidationErrorCategory;
  message: string;
  error_type?: string | null;
  pipe_code?: string | null;
  concept_code?: string | null;
  domain_code?: string | null;
  source?: string | null;
  field_path?: string | null;
  field_name?: string | null;
  variable_names?: string[] | null;
  missing_concept_code?: string | null;
  missing_pipe_code?: string | null;
  declared_concepts?: string[] | null;
  /** The server's deterministic repair proposal for this error, when it has one. */
  suggested_fix?: SuggestedFix | null;
}

/** Whether a `SuggestedFix` is safe to auto-apply, or needs explicit opt-in. */
export type FixSafety = "safe" | "unsafe";

/** The semantic patch operations a `SuggestedFix` is composed of. */
export type FixOpKind =
  | "set_key"
  | "ensure_table"
  | "delete_key"
  | "delete_table"
  | "rename_table_key"
  | "move_key"
  | "remap_value";

/** A TOML-representable scalar a `set_key` op can write. */
export type TomlScalar = string | number | boolean;

/**
 * What a `set_key` op writes: a scalar, or a flat scalar mapping for fixes that create
 * a whole table at once (written as an inline table). Deeper nesting is not modelled —
 * the server does not emit it.
 */
export type TomlValue = TomlScalar | Record<string, TomlScalar>;

/**
 * What every fix op carries: the table it acts in. `table_path` addresses the containing
 * table (e.g. `["pipe", "my_seq"]`), aligned with the `field_path` conventions of
 * `ValidationErrorItem`, and is empty for the document root.
 *
 * The segment `"*"` is the wildcard — "every entry of the open mapping at this node".
 * The server refuses it as a `key` on every kind but `remap_value`, the only one with a
 * per-key meaning for it.
 */
interface FixOpBase {
  table_path: string[];
}

/** Write `key = value` in the addressed table, whatever it currently holds. */
export interface SetKeyOp extends FixOpBase {
  kind: "set_key";
  key: string;
  value: TomlValue;
}

/** Create the addressed table when it is missing. `table_path` is never empty. */
export interface EnsureTableOp extends FixOpBase {
  kind: "ensure_table";
}

/** Remove `key` from the addressed table. */
export interface DeleteKeyOp extends FixOpBase {
  kind: "delete_key";
  key: string;
}

/** Remove the addressed table entirely. `table_path` is never empty. */
export interface DeleteTableOp extends FixOpBase {
  kind: "delete_table";
}

/** Rename `key` to `new_key` within the addressed table. */
export interface RenameTableKeyOp extends FixOpBase {
  kind: "rename_table_key";
  key: string;
  new_key: string;
}

/** Move `key` out of the addressed table into `new_table_path`, under `new_key`. */
export interface MoveKeyOp extends FixOpBase {
  kind: "move_key";
  key: string;
  new_table_path: string[];
  new_key: string;
}

/** Rewrite `key`'s value through `mapping`, leaving an unmapped value untouched. */
export interface RemapValueOp extends FixOpBase {
  kind: "remap_value";
  key: string;
  mapping: Record<string, string>;
}

/** One patch operation of a `SuggestedFix` — discriminated on `kind`. */
export type FixOp =
  | SetKeyOp
  | EnsureTableOp
  | DeleteKeyOp
  | DeleteTableOp
  | RenameTableKeyOp
  | MoveKeyOp
  | RemapValueOp;

/**
 * A deterministic fix for one validation error, ready for a style-preserving applier —
 * mirror of pipelex's `SuggestedFix`. The ops are semantic patches over the `.mthds`
 * document, not a text diff, so an applier keeps the author's formatting.
 */
export interface SuggestedFix {
  /** The kebab-case rule id, e.g. `"match-sequence-output"`. */
  fix_code: string;
  description: string;
  safety: FixSafety;
  /**
   * The file the ops target, when known (multi-file libraries). An applier must only
   * apply these ops to that file.
   */
  source?: string | null;
  ops: FixOp[];
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
 * Supply the closure EITHER as inline `files` OR as a `method_ref` — never both, and
 * never neither (both arms are a request-shape `422`). An **address-form** `method_ref`
 * (`github.com/<owner>/<repo>[/<selector>][@<tag>]`) is resolved by the server
 * (pipelex-api >= 0.21.0): the repository is fetched at the tag, the package is
 * located by manifest identity, and its `.mthds` files feed the closure with their
 * real relative paths as per-file sources. The **registry form** (any non-address
 * reference) stays reserved and answers `501` until a method registry exists.
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
  /**
   * The `/v1/build/*` projections take NO `method_id` — the hosted platform's
   * tooling selector covers `validate`/`resolve`/`codegen` only, and the build
   * routes are deliberately excluded (they are frozen, being replaced by the
   * codegen surface). Pinned to `never` so a stored-method caller reaches for
   * `getMethodClosure` instead of a field no server resolves.
   */
  method_id?: never;
}

export interface BuildInputsRequest extends BuildRequestBase {
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

/**
 * `POST /v1/resolve` request — the crate envelope (no projection axes) plus the
 * hosted `method_id` selector. Exactly one of `files` / `method_ref` /
 * `method_id` — the strict tooling XOR; see {@link PipelexHostedToolingExtensions}.
 */
export type ResolveRequest = CrateRequestBase & PipelexHostedToolingExtensions;

/**
 * The `/v1/resolve` valid arm — the normalized library crate.
 *
 * `crate` is the MTHDS **Library Crate Format**: fully qualified refs, refinement
 * flattened, natives materialized, top-level maps key-sorted, non-semantic provenance
 * dropped. Its `fingerprint` and `mthds_version` ride INSIDE the payload, not beside it.
 *
 * **Do not recompute the fingerprint by hashing this object.** It is a property of the
 * logical crate, not of any particular encoding: the server hashes `{concepts, pipes,
 * domains}` with each object's provenance `source` stripped, excluding `source_map`,
 * `mthds_version`, and `fingerprint` itself. Nor are these the same *bytes* the CLI
 * prints — `pipelex resolve --format json` pretty-prints, while this rides a compact
 * JSON response. Same logical crate, different serialization; compare `fingerprint`
 * values, never serialized bytes.
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

/**
 * `POST /v1/codegen` request — the crate envelope plus the two explicit projection
 * axes and the hosted `method_id` selector (exactly one of `files` / `method_ref` /
 * `method_id`; see {@link PipelexHostedToolingExtensions}).
 */
export interface CodegenRequest extends CrateRequestBase, PipelexHostedToolingExtensions {
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

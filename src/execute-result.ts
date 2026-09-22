/**
 * The blocking `execute()` result — a `DictRunResultExecute` that resolves its `.main_stuff` — and
 * the public lift from that result onto `RunResults`.
 *
 * Kept in its own module (mirroring the Python SDK's `execute_result.py`) so the
 * resolved-output concern sits apart from the raw wire models in `models.ts`. The lift lives here
 * for the same reason and in the same direction: it takes a `PipelexExecuteResult` and builds a
 * `RunResults`, so it belongs on the side that already depends on `runs.ts`.
 */

import type { DictPipeOutput, DictRunResultExecute, MethodProvenance } from "./models.js";
import { MissingMainStuffError } from "./errors.js";
import type { RunResults } from "./runs.js";

/**
 * Keys the extension-copy loop must never assign from wire data:
 * - `main_stuff` is the resolved-output getter on the prototype — a wire field of that name would
 *   shadow the accessor.
 * - `__proto__`, `constructor`, `prototype` are prototype-pollution vectors — assigning them from
 *   untrusted server data can change the instance prototype (via the `__proto__` setter) or corrupt
 *   property access. They are never legitimate extension fields, so skip them outright.
 */
const RESERVED_EXTENSION_KEYS = new Set(["main_stuff", "__proto__", "constructor", "prototype"]);

/**
 * The SDK's blocking `execute()` result — a `DictRunResultExecute` that also exposes the
 * resolved main output as `.main_stuff`.
 *
 * The protocol's raw execute response carries the working memory (`pipe_output`) and names the
 * main output via `main_stuff_name`, but not the output itself. The neutral `mthds` wire model
 * leaves `main_stuff_name` in its extension index signature; this Pipelex-branded subtype declares
 * it as a typed field (Pipelex owns that concept) and digs the output out on access, so callers
 * read `result.main_stuff` exactly the same way as on the durable path (`RunResults.main_stuff`) —
 * one output accessor across both execution modes, no working-memory spelunking.
 *
 * Extension-open like the wire model: any other server field is preserved on the instance (the
 * index signature), and the `main_stuff` getter lives on the prototype, so serializing the result
 * reproduces the wire shape (no fabricated `main_stuff` field).
 */
export class PipelexExecuteResult implements DictRunResultExecute {
  readonly pipeline_run_id: string;
  readonly pipe_output: DictPipeOutput;
  /**
   * The working-memory `root` key the completed execute response names as its main stuff
   * (pipelex >= 0.37 always sends it). `null` only if a runner omits it, in which case
   * `.main_stuff` throws `MissingMainStuffError`.
   */
  readonly main_stuff_name: string | null;
  /**
   * Provenance of a `method_ref` run — `{address, tag, commit_sha}`, the commit
   * SHA being what keeps the run explainable when a tag moves. Populated by the
   * extension-copy loop below (so serializing still reproduces the wire shape:
   * the key exists only when the server sent it); absent or `null` for runs
   * from inline source or a bundle. `declare` because this only narrows the
   * type of what the loop preserves — an emitted field definition would create
   * the own property first and make the loop skip the wire value.
   */
  declare readonly method_provenance?: MethodProvenance | null;
  /** Server-specific response fields (preserved verbatim — the wire model is extension-open). */
  [extension: string]: unknown;

  constructor(raw: DictRunResultExecute) {
    this.pipeline_run_id = raw.pipeline_run_id;
    this.pipe_output = raw.pipe_output;
    // `main_stuff_name` rides the wire model's extension index signature (typed `unknown`); narrow it.
    const rawName = raw.main_stuff_name;
    this.main_stuff_name = typeof rawName === "string" ? rawName : null;
    // Preserve any other server extension fields verbatim. Skip the declared fields above (own
    // properties, already set) via an own-property check — using `key in this` would also skip
    // any wire field whose name collides with an `Object.prototype` member (e.g. `toString`),
    // silently dropping it. RESERVED_EXTENSION_KEYS then excludes the prototype getter and the
    // prototype-pollution meta-keys so untrusted wire data can't shadow the accessor or mutate
    // the instance prototype.
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.prototype.hasOwnProperty.call(this, key) && !RESERVED_EXTENSION_KEYS.has(key)) {
        this[key] = value;
      }
    }
  }

  /**
   * The resolved main output content, dug out of the working memory via `main_stuff_name`.
   * Throws `MissingMainStuffError` if the completed run named no locatable main stuff. An
   * empty-but-present value (`{ items: [] }`, `{ text: "" }`) is a valid output and is returned
   * as-is.
   */
  get main_stuff(): unknown {
    const name = this.main_stuff_name;
    const stuff = name != null ? this.pipe_output?.working_memory?.root?.[name] : undefined;
    // Reject a missing entry AND a present entry with null/absent content — the durable path
    // rejects `main_stuff == null`, so the blocking accessor matches it (one-accessor invariant).
    // Loose `== null` catches only null/undefined; a falsy-but-present value (empty array, `0`,
    // empty string) is a valid output and passes through.
    if (stuff == null || stuff.content == null) {
      throw new MissingMainStuffError(
        `Blocking run '${this.pipeline_run_id}' delivered no locatable main stuff ` +
          `(main_stuff_name=${JSON.stringify(name)} is absent from the working-memory root, ` +
          `or its resolved content is null) — a completed run always delivers a main stuff.`,
        this.pipeline_run_id,
      );
    }
    return stuff.content;
  }
}

/**
 * Lift a blocking `execute()` result onto the lifecycle's `RunResults` — the same shape a durable
 * run hands back.
 *
 * `execute()` returns the runner's whole typed envelope, where the usage pair, the graph pair, the
 * working memory and the three I/O artifacts ride the extension-open `pipe_output` as Pipelex
 * extension fields. This function is the one place that lifts each onto the declared field of the
 * same name, so a caller driving the blocking route itself reaches `summarizeUsage`,
 * `collectArtifacts` and every other run-results field exactly as it would on the hosted path,
 * instead of re-reading `pipe_output` by hand. It is pure: no client, no network, no I/O.
 * `startAndWaitForResult` calls it on its bare-runner fallback, which is the only caller inside
 * the SDK.
 *
 * `response.main_stuff` resolves the main output out of the returned working memory (and throws
 * `MissingMainStuffError` if the run named no locatable main stuff), so the durable and blocking
 * paths hand back the same `main_stuff` content shape — the same shape the hosted path relays from
 * S3. The working memory, the graph pair, the three I/O artifacts and the usage pair are lifted off
 * `pipe_output` onto their own fields, so `working_memory`, `graph_spec`, the artifacts and the
 * usage pair read the same on both paths, and `pipe_output` itself still rides whole (blocking
 * only). `graph_assembly_error` and `pipe_io_artifacts_error` do not read the same yet: both are
 * lifted here but absent from the hosted body.
 */
export function resultsFromExecute(response: PipelexExecuteResult): RunResults {
  // `working_memory` is a declared field of `DictPipeOutput`, so it lifts without a cast. By the
  // time it is read, `main_stuff` has already been resolved out of it, so a response that carries
  // no working memory has thrown `MissingMainStuffError` above; the `?? null` keeps the blocking
  // path's convention for an absent key all the same. The graph pair and the usage pair ride
  // `pipe_output` as Pipelex extension fields, beside `working_memory` — `DictPipeOutput` is
  // extension-open, mirroring the Python model's `extra="allow"`, so they are read through the
  // type rather than by casting the whole value away. Lifting every one of them onto its
  // top-level field is what makes `.working_memory`, `.graph_spec` and `.tokens_usages` read the
  // same on the blocking and durable paths. The remaining casts are unavoidable: an
  // index-signature read is `unknown`, and this is unvalidated server JSON.
  //
  // The runner carries the three I/O artifacts in one envelope (`PipeIOArtifacts`: they share a
  // key set and are always built together), while the hosted results body relays them as three
  // sibling artifacts. `RunResults` follows the hosted shape and this unwraps the envelope onto
  // it, so `.pipe_io_contracts` and its two siblings read the same whichever path ran — the same
  // lift `working_memory` and the graph get.
  const pipeIoArtifacts = (response.pipe_output["pipe_io_artifacts"] ?? null) as {
    pipe_io_contracts?: RunResults["pipe_io_contracts"];
    input_form?: RunResults["input_form"];
    output_form?: RunResults["output_form"];
  } | null;
  return {
    pipeline_run_id: response.pipeline_run_id,
    main_stuff: response.main_stuff,
    working_memory: response.pipe_output.working_memory ?? null,
    graph_spec: response.pipe_output["graph_spec"] ?? null,
    graph_assembly_error: (response.pipe_output["graph_assembly_error"] ??
      null) as RunResults["graph_assembly_error"],
    pipe_io_contracts: pipeIoArtifacts?.pipe_io_contracts ?? null,
    input_form: pipeIoArtifacts?.input_form ?? null,
    output_form: pipeIoArtifacts?.output_form ?? null,
    pipe_io_artifacts_error: (response.pipe_output["pipe_io_artifacts_error"] ??
      null) as RunResults["pipe_io_artifacts_error"],
    pipe_output: response.pipe_output,
    tokens_usages: (response.pipe_output["tokens_usages"] ?? null) as RunResults["tokens_usages"],
    usage_assembly_error: (response.pipe_output["usage_assembly_error"] ??
      null) as RunResults["usage_assembly_error"],
  };
}

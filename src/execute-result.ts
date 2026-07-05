/**
 * The blocking `execute()` result — a `DictRunResultExecute` that resolves its `.main_stuff`.
 *
 * Kept in its own module (mirroring the Python SDK's `execute_result.py`) so the
 * resolved-output concern sits apart from the raw wire models in `models.ts`.
 */

import type { DictPipeOutput, DictRunResultExecute } from "./models.js";
import { MissingMainStuffError } from "./errors.js";

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
   * Throws `MissingMainStuffError` if the completed run named no locatable main stuff. A
   * falsy-but-present value (empty array, `0`) is a valid output and is returned as-is.
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

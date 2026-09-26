/**
 * A validation item reaches a caller with everything the runner put on it, under the
 * standard's vocabulary.
 *
 * Two things are shown. At run time, an `unknown_model` item — a model reference the
 * runner's model deck does not know — keeps the reference as written, its kind, the close
 * matches and the remap fix, on the two channels a refusal takes: the `/v1/validate`
 * invalid verdict and a run route's `422` problem document. At compile time, this SDK's
 * `ValidationErrorItem` and `SuggestedFix` are pinned to `mthds`'s declarations, so a
 * member the standard adds and this SDK misses, or the reverse, fails
 * `npm run typecheck:test`, which `make check` runs; `expectTypeOf` is erased at run time,
 * so vitest alone would not catch it.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
// The test is outside `src/`, so it may read the package root that `.dependency-cruiser.cjs`
// keeps the SDK itself from importing: that is where `mthds` exports these declarations.
import type {
  FixOp as MthdsFixOp,
  FixOpKind as MthdsFixOpKind,
  FixSafety as MthdsFixSafety,
  FixValue as MthdsFixValue,
  SuggestedFix as MthdsSuggestedFix,
  ValidationErrorCategory as MthdsValidationErrorCategory,
  ValidationErrorItem as MthdsValidationErrorItem,
} from "mthds";

import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import type {
  FixOp,
  FixOpKind,
  FixSafety,
  FixValue,
  SuggestedFix,
  TomlValue,
  ValidationErrorCategory,
  ValidationErrorItem,
} from "../src/index.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The item a runner sends for `model = "gpt-5.1"` in pipe `summarize`, as it serializes it
 * (`exclude_none`): one close match, so the item carries a `rename-model` fix remapping the
 * reference to it.
 */
const UNKNOWN_MODEL_ITEM = {
  category: "pipe_validation",
  error_type: "unknown_model",
  message: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  pipe_code: "summarize",
  domain_code: "demo",
  source: "demo.mthds",
  field_path: "pipe.summarize.model",
  field_name: "model",
  model_reference: "gpt-5.1",
  model_type: "llm",
  suggestions: ["gpt-5"],
  suggested_fix: {
    fix_code: "rename-model",
    description:
      "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    safety: "safe",
    source: "demo.mthds",
    ops: [
      {
        kind: "remap_value",
        table_path: ["pipe", "summarize"],
        key: "model",
        mapping: { "gpt-5.1": "gpt-5" },
      },
    ],
  },
} satisfies ValidationErrorItem;

/** Reads the item through its declared members only: this compiles only while they exist. */
function expectTheModelAndItsNextStep(item: ValidationErrorItem | undefined): void {
  expect(item).toEqual(UNKNOWN_MODEL_ITEM);
  expect(item?.pipe_code).toBe("summarize");
  expect(item?.model_reference).toBe("gpt-5.1");
  expect(item?.model_type).toBe("llm");
  expect(item?.suggestions).toEqual(["gpt-5"]);
  const fix = item?.suggested_fix;
  expect(fix?.description).toContain("with 'gpt-5'");
  const op = fix?.ops[0];
  if (op?.kind !== "remap_value") throw new Error("expected a remap_value op");
  expect(op.key).toBe("model");
  expect(op.mapping).toEqual({ "gpt-5.1": "gpt-5" });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an unknown model's refusal reaches the caller whole", () => {
  it("keeps the model, its kind, the suggestions and the fix on the validate verdict", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        validation_errors: [UNKNOWN_MODEL_ITEM],
        pending_signatures: [],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    );

    const report = await client.validate(["domain = 'demo'"], false, ["demo.mthds"]);

    if (report.is_valid !== false) throw new Error("expected the invalid arm");
    expectTheModelAndItsNextStep(report.validation_errors[0]);
  });

  it("keeps them on a run route's 422 problem document", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, {
        type: "https://docs.pipelex.com/latest/errors/validate-bundle-error/",
        title: "Bundle validation failed",
        status: 422,
        detail: "MTHDS validation found errors",
        error_type: "ValidateBundleError",
        error_domain: "input",
        validation_errors: [UNKNOWN_MODEL_ITEM],
      }),
    );

    const err = await client
      .execute({ pipe_code: "summarize", mthds_contents: ["domain = 'demo'"] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refusal = err as ApiResponseError;
    expect(refusal.errorDomain).toBe("input");
    expect(refusal.validationErrors).toHaveLength(1);
    expectTheModelAndItsNextStep(refusal.validationErrors?.[0]);
  });
});

/**
 * Each member of `T` without `null`. This SDK widens every optional member to `| null`
 * because the validate verdict's valid arm sends an unset locator as an explicit `null`;
 * `mthds`'s declarations drop the key instead, and are otherwise the same.
 */
type WithoutNull<T> = { [K in keyof T]: Exclude<T[K], null> };

describe("the validation vocabulary is the standard client's", () => {
  it("declares the item under mthds's members, names and types, widened to null", () => {
    expectTypeOf<Omit<WithoutNull<ValidationErrorItem>, "suggested_fix">>().toEqualTypeOf<
      Omit<MthdsValidationErrorItem, "suggested_fix">
    >();
    expectTypeOf<NonNullable<ValidationErrorItem["suggested_fix"]>>().toEqualTypeOf<SuggestedFix>();
    expectTypeOf<ValidationErrorCategory>().toEqualTypeOf<MthdsValidationErrorCategory>();
  });

  it("declares the suggested fix and its ops as mthds does", () => {
    expectTypeOf<WithoutNull<SuggestedFix>>().toEqualTypeOf<MthdsSuggestedFix>();
    expectTypeOf<FixOp>().toEqualTypeOf<MthdsFixOp>();
    expectTypeOf<FixOpKind>().toEqualTypeOf<MthdsFixOpKind>();
    expectTypeOf<FixSafety>().toEqualTypeOf<MthdsFixSafety>();
    expectTypeOf<FixValue>().toEqualTypeOf<MthdsFixValue>();
    expectTypeOf<TomlValue>().toEqualTypeOf<MthdsFixValue>();
  });
});

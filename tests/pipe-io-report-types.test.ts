/**
 * Pins the three artifacts `PipeIOValidReport` carries to the standard's declarations,
 * imported from `mthds/protocol` rather than restated — the same discipline
 * `validate-report-types.test.ts` applies to validate's report.
 *
 * The assertions are compile-time, and `npm run typecheck:test` is where they bite:
 * `expectTypeOf` is erased at run time, so a widening back to `Record<string, unknown>`
 * would still pass vitest while failing the typecheck `make check` runs. Unlike
 * validate's opt-in views, all three are REQUIRED here: the route has no `views` field
 * and its valid arm always carries them.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { InputForm, OutputForm, PipeIOContracts } from "mthds/protocol";

import type {
  CrateInvalidReport,
  MthdsFileItem,
  PipeIOResponse,
  PipeIOValidReport,
} from "../src/models.js";

describe("PipeIOValidReport — the standard's artifacts, imported", () => {
  it("types the three artifact maps as the standard's types, required", () => {
    expectTypeOf<PipeIOValidReport["pipe_io_contracts"]>().toEqualTypeOf<PipeIOContracts>();
    expectTypeOf<PipeIOValidReport["input_form"]>().toEqualTypeOf<InputForm>();
    expectTypeOf<PipeIOValidReport["output_form"]>().toEqualTypeOf<OutputForm>();
  });

  it("types the selection facts as nullable and the echo as optional", () => {
    expectTypeOf<PipeIOValidReport["pipe_ref"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PipeIOValidReport["default_pipe_ref"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PipeIOValidReport["files"]>().toEqualTypeOf<MthdsFileItem[] | undefined>();
  });

  it("discriminates the response on is_valid, with the crate family's invalid arm", () => {
    expectTypeOf<PipeIOResponse>().toEqualTypeOf<PipeIOValidReport | CrateInvalidReport>();
    const narrow = (response: PipeIOResponse): InputForm | undefined =>
      response.is_valid ? response.input_form : undefined;
    expect(
      narrow({
        is_valid: false,
        validation_errors: [],
        message: "MTHDS library could not be resolved",
      }),
    ).toBeUndefined();
  });
});

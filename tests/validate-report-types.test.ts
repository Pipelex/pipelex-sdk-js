/**
 * Pins the two validate-report fields this SDK narrows by importing the standard's
 * declarations rather than restating them: `pipe_io_contracts` and `input_form`.
 *
 * The assertions are compile-time, and `npm run typecheck:test` is where they bite —
 * `expectTypeOf` is erased at run time, so a widening back to `Record<string, unknown>`
 * would still pass vitest while failing the typecheck that `make check` runs. Two things
 * are pinned: that each field's type is exactly the `mthds/protocol` artifact type (not a
 * structurally similar local restatement, and not a widened one), and that a realistic
 * payload from the runner satisfies those types where the envelope carries them — an
 * annotated literal, so an excess member or a wrong discriminant arm is an error here
 * rather than a surprise at a consumer.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type { InputForm, PipeIOContracts } from "mthds/protocol";

import type { PipelexValidationReport } from "../src/models.js";

/** A single-input, single-output pipe contract, as the runner emits it. */
const contracts: PipeIOContracts = {
  "x.greet": {
    inputs: {
      profile: {
        concept_ref: "x.Profile",
        json_schema: {
          type: "object",
          properties: { full_name: { type: "string" } },
        },
        presence: "optional",
        multiplicity: "single",
        item_count: null,
      },
    },
    output: {
      concept_ref: "native.Text",
      multiplicity: "single",
      item_count: null,
      optional: false,
    },
  },
};

/** The same pipe's input form: one top-level object field, with the two pipe-slot facts. */
const inputForm: InputForm = {
  "x.greet": {
    fields: [
      {
        name: "profile",
        kind: "object",
        concept_ref: "x.Profile",
        title: "Profile",
        required: false,
        presence: "optional",
        gating: false,
        fields: [{ name: "full_name", kind: "text", required: true }],
      },
    ],
  },
};

describe("PipelexValidationReport — the standard's artifacts, imported", () => {
  it("types pipe_io_contracts as the standard's PipeIOContracts", () => {
    expectTypeOf<PipelexValidationReport["pipe_io_contracts"]>().toEqualTypeOf<PipeIOContracts>();
    expect(Object.keys(contracts)).toEqual(["x.greet"]);
  });

  it("types input_form as the standard's InputForm, optional because the view is opt-in", () => {
    expectTypeOf<PipelexValidationReport["input_form"]>().toEqualTypeOf<InputForm | undefined>();
    expect(inputForm["x.greet"]?.fields[0]?.name).toBe("profile");
  });

  it("carries both on the envelope, keyed over the same pipe refs", () => {
    const carried: Pick<PipelexValidationReport, "pipe_io_contracts" | "input_form"> = {
      pipe_io_contracts: contracts,
      input_form: inputForm,
    };
    expect(Object.keys(carried.input_form ?? {})).toEqual(Object.keys(carried.pipe_io_contracts));
  });
});

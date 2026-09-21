/**
 * E2E suite for `prepareInputs` — exercised against a LIVE pipelex-api (no fetch mocks).
 *
 * Run with `make test-e2e` (or `npm run test:e2e`) against a runner that serves the
 * input-form descriptor (pipelex-api >= 0.18.0), resolves an address server-side for the
 * `method_ref` cases (>= 0.21.0), and reports the resolved entry pipe as
 * `default_pipe_ref` for the two pipe-defaulting cases (>= 0.22.0). Below that last
 * floor the field is absent, so the blueprint and single-pipe fallbacks stand and both
 * of those cases fail — the `documents` one by refusing, the no-`main_pipe` one by
 * preparing:
 *
 *     PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com npm run test:e2e
 *
 * What the unit suite cannot prove: that the `validate` call this helper composes is
 * one a real server accepts and answers with a descriptor. Every mock in the repo
 * agrees with the client about the field names, so an `input_form` that never arrives
 * — a `views` token the server does not resolve, a selector shape it rejects — is
 * invisible until a live runner parses the request.
 *
 * These cases upload NOTHING on purpose: every asset is an `https://` URL, which the
 * walk passes through. That keeps the suite runnable against a bare runner with no
 * storage capability, and still exercises the whole signature path — the selector, the
 * descriptor, the pipe default, and the walk.
 *
 * `method_id` has no case here: a catalog id is resolved by the hosted platform against
 * an org's own methods, so there is no id a fresh checkout could name. The unit suite
 * pins that it reaches the wire as a pass-through selector.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PipelexApiClient } from "../../src/client.js";
import { InputPreparationError } from "../../src/errors.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

/** A published package whose entry pipe is named in METHODS.toml alone — see the defaulting case. */
const METHOD_REF = "github.com/Pipelex/methods/documents";
const METHOD_REF_PIPE = "documents.extract_document_text";

/** A reachable document the walk must pass through untouched. */
const REMOTE_DOC = "https://arxiv.org/pdf/2201.00001";

/** One domain, one main pipe, a Document input beside a Text one. */
const DOC_BUNDLE = `domain = "smoke_prepare"
main_pipe = "describe_doc"

[pipe.describe_doc]
type = "PipeLLM"
description = "Describe a document"
inputs = { doc = "Document", note = "Text" }
output = "Text"
prompt = """
Describe the document, taking $note into account.

@doc
"""
`;

/** One domain, one pipe, and no `main_pipe` — a closure a selector-less run cannot resolve. */
const NO_MAIN_BUNDLE = `domain = "smoke_prepare_no_main"

[pipe.describe_doc]
type = "PipeLLM"
description = "Describe a document"
inputs = { doc = "Document" }
output = "Text"
prompt = """
Describe the document.

@doc
"""
`;

describe("prepareInputs against a live runner", () => {
  let client: PipelexApiClient;

  beforeAll(() => {
    client = new PipelexApiClient({ baseUrl: BASE_URL });
  });

  it("prepares from inline files, defaulting the pipe through the bundle's main_pipe", async () => {
    const prepared = await client.prepareInputs({
      files: [{ content: DOC_BUNDLE, source: "smoke_prepare.mthds" }],
      inputs: { doc: REMOTE_DOC, note: "a short note" },
    });

    // The Document position is rewritten to canonical content; the Text one is not
    // touched, path-shaped or not. No upload: an http(s) URL passes through.
    expect(prepared.inputs).toEqual({ doc: { url: REMOTE_DOC }, note: "a short note" });
    expect(prepared.uploads).toHaveLength(0);
  });

  it("prepares from a method_ref address, resolved server-side", async () => {
    const prepared = await client.prepareInputs({
      method_ref: METHOD_REF,
      pipe_ref: METHOD_REF_PIPE,
      inputs: { document: REMOTE_DOC },
    });

    expect(prepared.inputs).toEqual({ document: { url: REMOTE_DOC } });
    expect(prepared.uploads).toHaveLength(0);
  });

  it("defaults a manifest-only main_pipe package through the report's resolved default", async () => {
    // `Pipelex/methods/documents` declares its entry pipe in METHODS.toml, not in the
    // bundle, and the validate report carries no manifest — the runner qualifies the
    // manifest's `main_pipe` server-side onto `default_pipe_ref`, so preparation
    // defaults to the pipe a selector-less run would execute, with no `pipe_ref`.
    const prepared = await client.prepareInputs({
      method_ref: METHOD_REF,
      inputs: { document: REMOTE_DOC },
    });

    expect(prepared.inputs).toEqual({ document: { url: REMOTE_DOC } });
    expect(prepared.uploads).toHaveLength(0);
  });

  it("refuses a closure with one pipe and no main_pipe, which the server answers with a null default", async () => {
    // The run route has no single-pipe fallback: a selector-less run of this bundle is
    // refused, and a runner serving `default_pipe_ref` says so with a stated `null`.
    // Preparation stops there instead of walking the only pipe declared.
    const failure = client.prepareInputs({
      files: [{ content: NO_MAIN_BUNDLE, source: "smoke_prepare_no_main.mthds" }],
      inputs: { doc: REMOTE_DOC },
    });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/pipe_ref/);
    await expect(failure).rejects.toThrow(/smoke_prepare_no_main\.describe_doc/);
  });
});

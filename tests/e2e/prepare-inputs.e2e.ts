/**
 * E2E suite for `prepareInputs` — exercised against a LIVE pipelex-api (no fetch mocks).
 *
 * Run with `make test-e2e` (or `npm run test:e2e`) against a runner that serves the
 * input-form descriptor (pipelex-api >= 0.18.0), and, for the `method_ref` cases, one
 * that resolves an address server-side (>= 0.21.0):
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

/** A published package whose entry pipe is named in METHODS.toml alone — see the last case. */
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

  it("refuses a manifest-only main_pipe package with no pipe_ref, naming the candidates", async () => {
    // `Pipelex/methods/documents` declares its entry pipe in METHODS.toml, not in the
    // bundle, and the validate report carries no manifest — so the helper cannot default
    // and says so with the qualified refs listed. Pinned as behaviour until the report
    // carries a typed resolved default (L-260829-0208c7), after which this call succeeds.
    const failure = client.prepareInputs({ method_ref: METHOD_REF, inputs: {} });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/pipe_ref/);
    await expect(failure).rejects.toThrow(new RegExp(METHOD_REF_PIPE.replace(".", "\\.")));
  });
});

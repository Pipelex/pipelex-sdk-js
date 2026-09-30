/**
 * E2E suite for `prepareInputs` — exercised against a LIVE pipelex-api (no fetch mocks).
 *
 * Run with `make test-e2e` (or `npm run test:e2e`) against a runner that serves
 * `POST /v1/pipe-io`, which `prepareInputs` reads its pipe and its signature from. The
 * two refusal cases also need the route's selection `422`s typed `EntryPipeNotFoundError`,
 * which pipelex-api does from v0.33.1:
 *
 *     PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com npm run test:e2e
 *
 * What the unit suite cannot prove: that the `pipeIo` call this helper composes is one
 * a real server accepts and answers with the descriptor of the pipe it selected. Every
 * mock in the repo agrees with the client about the field names and the selection
 * rules, so a selector shape the server rejects, or a refusal it types differently, is
 * invisible until a live runner parses the request.
 *
 * These cases upload NOTHING on purpose: every asset is an `https://` URL, which the
 * walk passes through. That keeps the suite runnable against a bare runner with no
 * storage capability, and still exercises the whole signature path — the selector, the
 * route's pipe selection, the descriptor, and the walk.
 *
 * The `method_id` case runs only when `PIPELEX_E2E_METHOD_ID` names a stored method the
 * key's organization owns, with a pipe that takes a `document` input as its entry pipe:
 * a catalog id is resolved by the hosted platform against an org's own methods, so there
 * is no id a fresh checkout could name, and a bare runner has no catalog. It is skipped
 * otherwise; the unit suite pins that the id reaches the wire as a pass-through selector.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PipelexApiClient } from "../../src/client.js";
import { InputPreparationError } from "../../src/errors.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

/** A stored method the key's organization owns — hosted origins only. */
const METHOD_ID = process.env.PIPELEX_E2E_METHOD_ID || undefined;

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

  it("prepares from inline files, the route selecting the bundle's main_pipe", async () => {
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

  it("prepares a manifest-only main_pipe package with no pipe_ref, the route reading the manifest", async () => {
    // `Pipelex/methods/documents` declares its entry pipe in METHODS.toml, not in the
    // bundle. The route qualifies the manifest's `main_pipe` against the closure, so
    // preparation walks the pipe a selector-less run would execute.
    const prepared = await client.prepareInputs({
      method_ref: METHOD_REF,
      inputs: { document: REMOTE_DOC },
    });

    expect(prepared.inputs).toEqual({ document: { url: REMOTE_DOC } });
    expect(prepared.uploads).toHaveLength(0);
  });

  it("refuses a closure with one pipe and no main_pipe, which the route will not select", async () => {
    // The run route has no single-pipe fallback: a selector-less run of this bundle is
    // refused, and the route refuses the selection the same way. Preparation stops
    // there instead of walking the only pipe declared.
    const failure = client.prepareInputs({
      files: [{ content: NO_MAIN_BUNDLE, source: "smoke_prepare_no_main.mthds" }],
      inputs: { doc: REMOTE_DOC },
    });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/main_pipe/);
  });

  it("refuses a pipe_ref the method does not declare, carrying the route's detail", async () => {
    const failure = client.prepareInputs({
      files: [{ content: DOC_BUNDLE, source: "smoke_prepare.mthds" }],
      pipe_ref: "smoke_prepare.absent",
      inputs: { doc: REMOTE_DOC },
    });

    await expect(failure).rejects.toBeInstanceOf(InputPreparationError);
    await expect(failure).rejects.toThrow(/smoke_prepare\.absent/);
  });

  it.skipIf(METHOD_ID === undefined)("prepares from a hosted method_id", async () => {
    const prepared = await client.prepareInputs({
      method_id: METHOD_ID!,
      inputs: { document: REMOTE_DOC },
    });

    expect(prepared.inputs).toEqual({ document: { url: REMOTE_DOC } });
    expect(prepared.uploads).toHaveLength(0);
  });
});

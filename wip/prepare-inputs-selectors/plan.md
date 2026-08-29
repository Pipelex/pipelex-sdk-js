---
status: draft
item: L-260829-300c50
---

# Plan — `prepareInputs` on the input-form descriptor, with all three selectors

Design: [`design.md`](./design.md). This tracker carries the phases, the decisions taken while implementing, and the checkpoint hand-offs. It records what cannot be re-derived from the tree — never whether something is committed, pushed, or passing right now. It is the `@pipelex/sdk` member of the workspace campaign `wip/build-retirement/`.

## Scope

One PR against `dev` in `pipelex-sdk-js`, from a `feature/PrepareInputsSelectors` branch, with `Closes L-260829-300c50` and `Advances L-260826-ddd843` in its body. It moves `prepareInputs`' signature source from `POST /v1/build/inputs` to `validate` + `views: ["input_form"]`, adds the `method_ref` and `method_id` selectors, replaces the shape-sniffing walk with the descriptor-guided one, and corrects the documents. No version bump: that is the release's business.

Out of scope, and why: the build wrappers stay exported (their retirement is its own program member, sequenced with the template consumers); the platform sniff table is untouched (a decision item in the program); the Python twin is its own item and mirrors this one; the MCP consumer change is its own item, blocked on this release.

## Phase 1 — the surface, the signature call, the walk

Files: `src/prepare-inputs.ts`, `src/index.ts`.

- Replace `PrepareInputsRequest` with the `PrepareInputsBase & PrepareInputsClosure` union; export `PrepareInputsClosure` from the barrel.
- `PrepareCapableClient` becomes `{ upload, validate }` — `validate` typed as the client's own signature (`source: string[] | ValidateMethodSelector`, `allowSignatures`, `mthdsSources`, `render`, `views`, `options`).
- Selector resolution: normalise empty selectors to absent; throw `InputPreparationError` for none or several; build the `validate` call — for `files`, contents plus per-file sources following `validateFiles`' rule (`source ?? inline://file-N.mthds`); for the two selectors, the selector object — with `views: ["input_form"]`, `allowSignatures: true`, and for a `method_ref` the fetch-sized `timeoutMs` if `validate` does not apply it itself (see Phase 1b).
- Verdict handling: `is_valid: false` → `InputPreparationError` with the first error message; a valid report without `input_form` → `InputPreparationError` naming the pipelex-api floor.
- Pipe selection per the design: explicit `pipe_ref`, qualified-only (a bare value or an unknown ref → error listing the qualified refs), else the report's typed resolved default when present (`L-260829-0208c7`; read leniently — absent on servers that predate it), else `bundle_blueprint.main_pipe` qualified by `bundle_blueprint.domain` (defensive reads on the opaque record), else the single pipe, else an error asking for `pipe_ref`.
- The walk: `resolveNode(ctx, node: InputFormItem, value)` discriminated on `node.kind` — `document` / `image` → `resolveFilePosition` (unchanged); `object` → walk `fields` by name, copying undeclared keys; `list` → walk `item` per element; every other kind → pass through. Top level: look the input up by name in the chosen pipe's `fields`; unwrap and re-wrap the explicit envelope as today.
- Docstrings: the module header, the request type, and the walk.

Phase 1b — `src/client.ts`.

- Check whether `validate` applies `METHOD_REF_FETCH_TIMEOUT_MS` to a `{ method_ref }` source. If not, apply the same rule `crateRequestTimeoutMs` applies to the crate routes, inside `validate`, so every `method_ref` validate gets the fetch budget.
- Docstrings: `getMethodClosure` (no longer the way into `prepareInputs`), `buildInputs` (the helper no longer depends on it), the `prepareInputs` method (one line per selector, the descriptor as the source). `src/errors.ts`: drop `prepareInputs` from the `EmptyMethodSourceError` docstring.

## Phase 2 — tests

File: `tests/prepare-inputs.test.ts`. The fake client's `buildInputs` becomes a recording `validate` that captures the request and returns a canned valid report carrying `input_form` (and, where a case needs it, `bundle_blueprint`). Fixtures are descriptor nodes (`kind`, `name`, `required`, `fields`, `item`) instead of template entries.

- **Wire, per selector** — `files` arrives as contents plus sources (labelled `inline://file-N.mthds` when unlabelled); `{ method_ref }` and `{ method_id }` arrive as the selector object; every call carries `views: ["input_form"]` and `allowSignatures: true`; the `method_ref` call carries the fetch budget when Phase 1b put it on the helper.
- **The behaviour matrix, re-expressed on the descriptor** — every existing walk case (top-level bytes, http pass-through, storage-URI pass-through, data URL, list of documents, text left alone, nested image in a structured input, dedup, copy-on-write, undeclared input pass-through, real local path, unrecognised value, malformed data URL, rejected asset) plus the envelope suite, unchanged in expectation.
- **The two fixed edges** — an optional nested `document` field (`required: false`) is uploaded when present; a `text` field named `url` inside an `object` is left untouched even with a path-like value.
- **Refining and nesting** — a `document` node with `refines: ["native.Document"]` is a file position; an `image` inside a `list` of `object`s is uploaded per element.
- **Unknown** — a bare string at an `unknown` input passes through; a canonical file dict with a local path nested inside an `unknown` input passes through, no upload (the deliberately changed case, with the reason in the test's comment).
- **Pipe selection** — explicit qualified ref; a bare value → error naming the qualified candidates; unknown ref → error listing refs; the typed default when the report carries it (and it outranks `bundle_blueprint.main_pipe`); `bundle_blueprint.main_pipe` default; single-pipe default; several pipes and no main → error asking for `pipe_ref`; the manifest-only case (an `image_generation`-shaped fixture: `main_pipe: null`, several pipes, no typed default) → the same error, so the gap is pinned as behaviour until `L-260829-0208c7` lifts it.
- **Verdicts and errors** — `is_valid: false` → `InputPreparationError`; valid without `input_form` → `InputPreparationError` naming the floor; an `ApiResponseError` from `validate` propagates unchanged; selector guards (none, two, three, empty forms, an empty beside a real one).
- **Types** — each single-selector arm compiles; each pair and the no-selector shape are `@ts-expect-error`.

File: `tests/build-routes.test.ts` — unchanged unless the `buildInputs` teaching error's wording changes.

File: `tests/e2e/` — one live case per selector that a bare runner can serve: `files` and `method_ref` (`github.com/Pipelex/methods/documents`, `pipe_ref: "documents.extract_document_text"`, an `https://` document passing through with no upload). Runs with `make test-e2e` against pipelex-api >= 0.21.0. `method_id` cannot be exercised against a bare runner; the unit wire test covers it.

Commands: `make check`, `make test`, and `make test-e2e` when a live runner is available.

### Checkpoint A — after Phase 2

Record under "Checkpoint log": whether `validate` already applied the fetch budget (Phase 1b's finding), the guard and pipe-selection message wordings, and whether the e2e cases ran and against which base URL.

## Phase 3 — documentation and changelog

- `docs/input-preparation.md`: the "Current scope" note; the `prepareInputs` section (three call shapes, the signature call, pipe selection); "Signature-driven asset identification" rewritten on the descriptor, with the "Why not `input_form`?" note replaced by "Why the descriptor, and why not the template" (the `url`-named-field side effect, the optional-field gap, the standard's ownership, one round trip either way); the "Closure from a stored `method_id`" section reduced to `getMethodClosure` as the expansion utility for `buildInputs`; the error section (no `EmptyMethodSourceError` from the helper; the missing-descriptor error).
- `docs/architecture.md`: the hosted-extensions "pure pass-through" bullet (now true of `prepareInputs` too), the build-helpers bullet (the helper no longer depends on them), the storage bullet, the methods-catalog bullet describing `getMethodClosure`.
- `docs/build-routes.md`: one sentence — `prepareInputs` no longer reads the template; the routes' retirement is tracked by the workspace campaign.
- `CHANGELOG.md`, under a new `## [Unreleased]`: Added (`method_ref` and `method_id` on `prepareInputs`, all three server-resolved); Changed (the signature source is the input-form descriptor via `validate`; `PrepareInputsRequest` is a union — source-compatible for every caller passing `files`; the Dynamic-nested file dict is no longer uploaded, with the reason); Fixed / Security (the two misclassifications of `L-260826-ddd843`: optional nested file fields now uploaded, `url`-named text fields no longer read from disk); Fixed (the documentation that generalised the build-route freeze to the address form).

Run `make check` again.

### Checkpoint B — before the PR

Record the final exported surface, the changelog entry as written, and anything deliberately left out.

## Phase 4 — pull request and the ledger

- PR against `dev`; body: `Closes L-260829-300c50`, `Advances L-260826-ddd843` (the Python twin closes the other half). Babysit the review bots by the workspace rule.
- After the merge: `/ledger-land` here. The release (`/release`, a minor bump) is what unblocks the MCP member.

## Decisions taken

- 2026-08-29 — `prepareInputs` takes all three selectors (Louis).
- 2026-08-29 — The signature source moves from the explicit template to the input-form descriptor via `validate` + `views`, which makes every selector a server pass-through and removes the SDK's runtime dependence on `/v1/build/inputs` (`design.md`, "What was found" and "The ruling").
- 2026-08-29 — The request type is a discriminated union with `never` pins; empty selectors are absent; the helper owns the exactly-one check.
- 2026-08-29 — `allowSignatures: true` on the signature call: preparation needs declared inputs, not a runnable bundle.
- 2026-08-29 — A file dict nested inside an `unknown` (Dynamic) input is no longer uploaded: uploading by value shape is the defect being removed.
- 2026-08-29 — `pipe_ref` is qualified-only, per the pipe-selector campaign's convention (`wip/pipe-selector/design.md`); the helper never grows a searched `pipe_code`.
- 2026-08-29 — The report's typed resolved default (`L-260829-0208c7`) is read when present and outranks the `bundle_blueprint` read; it is not a blocker — the manifest-only `main_pipe` gap is accepted with an honest error until it ships.
- 2026-08-29 — This item does not wait for the addressing campaign's Workstream B; the envelope cut sweeps this one call site (design, "Where the signature comes from").

## Open questions

- Does `validate` already apply the fetch-sized budget to a `{ method_ref }` source? Settled in Phase 1b; record the answer here.
- Whether the `buildInputs` teaching error should still point at `getMethodClosure` or now at `prepareInputs` — decide in Phase 1b.
- The hosted e2e for `method_ref` and `method_id` through `prepareInputs`: dev serves both since the 2026-08-29 deploy (`api-dev.pipelex.com` 0.11.1 — `validate` by `method_ref` and by `method_id` with `views: ["input_form"]` both returned the descriptor, checked the same day). Dev is the hosted target; record at Checkpoint A the base URL the e2e ran against.

## Checkpoint log

(Empty until Checkpoint A.)

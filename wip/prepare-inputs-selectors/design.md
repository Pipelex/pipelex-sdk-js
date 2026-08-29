---
status: draft
item: L-260829-300c50
---

# `prepareInputs` takes the method as any selector, and reads its signature from the input-form descriptor

## History of this document

A first draft on 2026-08-29 kept `prepareInputs` on `POST /v1/build/inputs` and added the two missing selectors around it: `method_ref` forwarded to the build route, `method_id` expanded client-side through `getMethodClosure` because the platform's `method_id` resolution deliberately excludes `/v1/build/*`. Louis reviewed it the same day and reframed the problem: the ruling that froze the build routes was aimed at the spec-in/TOML-out authoring routes (`/build/concept`, `/build/pipe-spec`) that the new `pipelex-plugins` skills no longer use, not at the inputs template, and the aim is to drop `/v1/build/*` entirely once nothing depends on it — while landing full uniformity now, every method-taking operation accepting inline files, a `method_ref`, or a `method_id` the same way. Four investigations followed (codegen internals, the consumer inventory, the written record, and the descriptor as a classifier); this is the design they produced. The program that retires the build routes across repos is the workspace campaign `wip/build-retirement/` (its epic is named in that directory's `plan.md`); this document is the `@pipelex/sdk` member of it.

## What was found

**The inputs template has one engine and four surfaces, and only one of them is HTTP.** `build_inputs_template` (`pipelex/pipelex/pipe_machinery/rendering/input_renderer.py`) backs `pipelex build inputs`, `pipelex-agent inputs`, `pipelex codegen inputs`, and `POST /v1/build/inputs`. Over HTTP, `POST /v1/codegen` serves exactly one kind, `types`, and both the route (`pipelex-api/api/routes/pipelex/codegen.py`, `CodegenRouteKind`) and the spec (`docs/specs/pipelex-codegen.md`, "the durable route-membership rule") say why `inputs` is not a kind there: a template is an editable scaffold that can never be stamped or locked, so it cannot honour the codegen valid arm's `lock` promise. So the answer to "does codegen build inputs?" is: at the CLI yes, over HTTP no, by a rule the spec calls durable. There is no HTTP replacement for the template on record; the addressing design says the MCP may keep using `/build/inputs` "until the replacement surface exists" without naming one.

**`/v1/build/inputs` is load-bearing at runtime, not just for authoring.** Both SDKs' `prepareInputs` / `prepare_inputs` call it unconditionally on every upload walk (`src/prepare-inputs.ts`, `pipelex-sdk-python/pipelex_sdk/prepare_inputs.py`); the Python SDK's `build_inputs` exists solely for that. Through them it carries `pipelex-mcp`'s `mthds_prepare_inputs` and `pipelex-starter-js`'s PDF flow. Its other consumers are the template projections: the MCP's `mthds_inputs_template`, `mthds-agent inputs bundle|pipe|method` on the API runner (used by five `mthds-plugins` skills), and `pipelex-app`'s deploy dialog. `/build/output` and `/build/runner` have no consumer outside this SDK's own wrappers; `/build/concept` and `/build/pipe-spec` have one consumer path, `mthds-agent concept|pipe --spec` on the API runner, used by the `mthds-build` skill.

**The validate report's `input_form` descriptor is a better signature source than the template, and it is already the standard's artifact.** The template marks a file position by rendering `{"url": …}` — a side effect of a field being *named* `url` or `*_url` (`pipelex/pipelex/core/concepts/concept_representation_generator.py`), not of the field being an Image or Document. The descriptor (`mthds/protocol`'s `InputForm`, produced by `build_input_form` from the authored blueprints) states the kind at every depth — `document`, `image`, `object` with `fields`, `list` with `item`, `unknown` for Dynamic — and states a refining concept's chain through `refines`. It locates every position the template walk finds today (top level, nested in a structured concept, inside lists, inside a pinned native's structure, refining concepts) and fixes the two live misclassifications that `L-260826-ddd843` (P1, security) reports: an optional nested file field the required-only template never enumerates, and a text field named `url` uploaded by shape. `@pipelex/mthds-form`, `pipelex-app`, `mthds-ui`, `pipelex-mcp` and `pipelex-starter-js` already derive from the descriptor; `mthds-form/src/core/derive.ts` records that "the url-bearing object test" was deleted, not bypassed. `prepareInputs` is the last shape-sniffing consumer.

**`/v1/validate` already takes all three selectors, server-resolved.** `validate` accepts inline contents, `{ method_ref }` (runner-resolved by address) or `{ method_id }` (platform-resolved; `/validate` is in the platform's sniff table, `pipelex-server/platform/src/pipelex_platform/routers/v1/tooling_proxy.py`), and `views: ["input_form"]` carries the descriptor on the valid arm. Nothing has to be expanded client-side and nothing has to change on the server for the helper to become uniform.

## The ruling

Decided by Louis on 2026-08-29: `prepareInputs` takes the method the same three ways as every other method-taking surface — inline `files`, a `method_ref` address, or a `method_id` catalog id — exactly one per call, and the solution must be the one that remains stable when `/v1/build/*` is gone. That solution is to move the helper's signature source from the explicit template to the input-form descriptor, obtained through `validate`.

## The surface

```ts
interface PrepareInputsBase {
  /** The pipe to prepare inputs for, as a qualified `domain.pipe_code`; omit to default (see "Pipe selection"). */
  pipe_ref?: string;
  /** The caller's inputs (variable name → value), compact or explicit-envelope per input, as today. */
  inputs: Record<string, unknown>;
}

/** Exactly one way of naming the method — the closure selector. */
type PrepareInputsClosure =
  | { files: MthdsFileItem[]; method_ref?: never; method_id?: never }
  | { method_ref: string; files?: never; method_id?: never }
  | { method_id: string; files?: never; method_ref?: never };

export type PrepareInputsRequest = PrepareInputsBase & PrepareInputsClosure;
```

```ts
await client.prepareInputs({ files, pipe_ref: "documents.extract_document_text", inputs });
await client.prepareInputs({ method_ref: "github.com/Pipelex/methods/documents@v0.1.0", pipe_ref: "documents.extract_document_text", inputs });
await client.prepareInputs({ method_id: "mt_…", inputs });
```

The result type (`PreparedInputs`: rewritten copy-on-write `inputs` plus `uploads`), the upload and pass-through rules, dedup by source identity, and the explicit-envelope handling are unchanged.

**Exclusivity is a type-level XOR, backed at runtime.** Each arm pins the other two keys to `never`, as `ValidateMethodSelector` does; untyped callers get an `InputPreparationError` for no selector, more than one, or only empty ones. Empty is absent — `method_ref: ""`, `method_id: ""`, `files: []` — mirroring the run options' rule and the Python `CrateRequestBase` normalisers. The helper owns this check because it is the one that composes the call.

## Where the signature comes from

One call, whatever the selector:

| Selector | `validate` source argument | Resolved by |
|---|---|---|
| `files` | the file contents as `mthds_contents`, with `source` as the per-file label (`inline://file-N.mthds` when absent — the `validateFiles` rule) | nobody — inline |
| `method_ref` | `{ method_ref }` | the runner, server-side (git fetch at the tag; pipelex-api >= 0.21.0) |
| `method_id` | `{ method_id }` | the platform, server-side (org-scoped catalog; a pure pass-through, never expanded here) |

with `views: ["input_form"]` and `allowSignatures: true`. The descriptor is what preparation needs — a pipe's declared inputs — and a bundle mid-authoring with an unresolved signature elsewhere must not be refused inputs for a pipe whose inputs are declared; whether the bundle runs is the run's verdict, not preparation's. The `is_valid: false` arm still means the closure does not load, and that is a preparation failure as it is today.

`method_id` on this helper is therefore exactly what 0.16.0's rule requires — a server pass-through — and `getMethodClosure` stays what it is, the public expansion utility for callers who want files in hand. The first draft's route-wrapper-versus-helper distinction is not needed and is not kept.

**Workstream B.** The MTHDS Protocol 0.7.0 cut (`wip/addressing-methods/plan-protocol-envelope.md`, gated on the addressing campaign's Checkpoint 3) replaces `mthds_contents` + `mthds_sources` with `files: [{path?, content}]` and renames the crate entry's `source` to `path`. This helper is written on the current shapes; when B5 rewrites `validate` in this SDK, the `files` row of the table above becomes a straight pass of the caller's entries and `MthdsFileItem` follows the rename — one call site, swept by the cut like every other. Recorded there as blast-radius item 9.

## The classifier: a descriptor-guided walk

The walk is unchanged in shape — top-down, template-guided, copy-on-write — with the descriptor node in place of the template node:

- The top-level input `name` selects the `InputFormTopLevelField` of the chosen pipe's `fields`; an input the descriptor does not declare passes through untouched, as today.
- A `document` or `image` node marks a file position. The caller's value there is resolved exactly as today: a local path, `data:` URL, or bytes is uploaded and rewritten to canonical content carrying `pipelex-storage://` in `url`; an `http(s)` URL or an existing storage URI passes through; a canonical `{ url }` content dict has its `url` resolved and its other keys preserved. Whether the concept is native or refines `Document` / `Image` is the descriptor's statement (`refines`), never a shape test.
- An `object` node walks its `fields` by name against a plain-object caller value; keys the descriptor does not name are copied through. Optional fields (`required: false`) are walked when present — the first edge of `L-260826-ddd843`.
- A `list` node walks its `item` against each element of an array caller value.
- Every other kind — `text`, `prose`, `date`, `number`, `boolean`, `enum`, and `unknown` — passes through at any depth. A text field named `url` is `kind: "text"` and is never touched — the second edge of `L-260826-ddd843`. A `Dynamic` / `Composite` input is `kind: "unknown"` and is not interpreted, including a canonical file dict nested inside it: the signature genuinely does not declare a file there, and uploading by value shape is the defect this change removes. That deliberately changes one existing test ("uploads a canonical Image dict nested inside a Dynamic input"); a caller with a Dynamic input uploads with `uploadFile` first and passes the storage URI, which is what `docs/input-preparation.md` has said all along.
- The explicit `{ concept, content }` envelope at the top level is unwrapped, its `content` walked against the same node, and re-wrapped — unchanged.

`isFileContent` and `isExplicitEnvelope` survive only as value-shape helpers at a position the descriptor has already declared a file; the classifier no longer reads them as signals.

## Pipe selection

`validate` has no pipe selector: the report describes every pipe, keyed by qualified `pipe_ref`. The helper picks:

1. `pipe_ref` when given. It is qualified-only (`domain.pipe_code`), the workspace convention the pipe-selector campaign pins (`wip/pipe-selector/design.md`: `_ref` is the always-namespaced form, `_code` the bare one). A bare value, or a ref the descriptor does not carry, is an `InputPreparationError` listing the qualified refs the descriptor carries — one step to fix. The helper never grows a searched `pipe_code`: search is a run-route affordance, and the descriptor is keyed by qualified refs. An `alias->domain.pipe_code` ref is out of reach here too, and not by omission: the alias names a dependency package's pipe, and the report's `input_form` covers the method's own pipes only, so there is no descriptor to prepare against.
2. Otherwise the report's typed resolved default pipe ref, once `pipelex-api` serves it (`L-260829-0208c7`): the qualified ref a caller gets by omitting the selector on the run and build routes — for a `method_ref` package, the manifest's `main_pipe` first, as `resolve_requested_pipe` does since `pipelex-api#67` — or `null` when the closure declares none or several. Read when present; absent on servers that predate it.
3. Otherwise the bundle's declared main pipe, read from the report's `bundle_blueprint` (`main_pipe` qualified by `domain`) — read defensively, because that artifact is typed opaque in this SDK on purpose.
4. Otherwise, if the descriptor carries exactly one pipe, that pipe.
5. Otherwise an `InputPreparationError` listing the refs and asking for `pipe_ref` — the case `github.com/Pipelex/methods/documents` presents (`main_pipe: null`, several pipes), which is why the starter's Dynamic tab picks the pipe explicitly.

**The manifest-only `main_pipe` gap, stated honestly.** A fetched package may name its entry pipe only in `METHODS.toml` — `image_generation` and `documents` do, in `Pipelex/methods` today; the other seven also declare it in their bundle — and the validate report never carries a manifest's `main_pipe`. Until step 2's field ships, `prepareInputs({ method_ref, inputs })` on such a package refuses with the candidates listed, where `/build/inputs` (post-`#67`) defaults through the manifest; the caller passes `pipe_ref` and is done. That is why the typed default is a Wave 0 member of the program at normal priority, and why it is not a blocker of this item.

## Errors and no-verdict conditions

All failures are raised before any upload and before any run exists.

- Selector shape — none, several, or only empty selectors: `InputPreparationError` naming the three forms.
- `is_valid: false`: `InputPreparationError` carrying the first validation error's message, as today.
- A valid report with no `input_form`: `InputPreparationError` naming the pipelex-api floor (the `views` gate is honoured from 0.18.0; 0.17.0 emitted the descriptor ungated). Never a silent degrade to "no uploads".
- No verdict — a malformed selector (422), an unknown or foreign-org `method_id` (404, indistinguishable by design), a stored method with no source (422), no package at the address or a fetch failure (422), the registry form (501): the route's `ApiResponseError`, propagated unchanged.
- Unknown `pipe_ref`, or no default: `InputPreparationError` as under "Pipe selection".
- `EmptyMethodSourceError` is no longer raised by this helper (the platform's 422 covers that case for a `method_id`); it stays on `getMethodClosure`.

## Timeouts

A `method_ref` can make the server clone a repository before it answers. `resolve`, `codegen` and the build routes already get the internal fetch-sized budget through `crateRequestTimeoutMs`; the plan checks whether `validate` applies the same rule to a `{ method_ref }` source and, if not, gives it the same budget there — the right place, since every `method_ref` validate can clone, not only the ones this helper makes.

## What changes in this SDK

- `src/prepare-inputs.ts`: the selector union and guards; `PrepareCapableClient` becomes `{ upload, validate }`; the descriptor walk; pipe selection. `buildInputs` is no longer called by anything in the SDK.
- `src/client.ts`: `validate`'s fetch budget for a `method_ref` source if missing; docstrings on `getMethodClosure`, `buildInputs`, `prepareInputs`.
- `src/errors.ts`: the `EmptyMethodSourceError` docstring drops `prepareInputs`.
- The build wrappers (`buildInputs`, `buildOutput`, `buildRunner`, `concept`, `pipeSpec`) stay exported in this change; their retirement is a separate member of the program, sequenced with the consumers that still use `/v1/build/inputs`.
- Documentation: `docs/input-preparation.md` is rewritten around the descriptor — the "Why not `input_form`?" note becomes "Why the descriptor, and why not the template" — and `docs/architecture.md`, `docs/build-routes.md` and the changelog move with it.

## Cost and known limits

- `validate` runs the dry-run sweep the static build route skipped, so the signature call is heavier. Measured on `api-dev.pipelex.com` on 2026-08-29, a `method_ref` validate including the server-side fetch answered in about 1.7 s. A consumer that has already validated (the MCP, the starter's Dynamic tab) pays the call twice; letting it hand the descriptor in directly is a deliberate deferral — additive, and worth doing only if a consumer measures the cost.
- Class-backed concepts (`structure = "SomeClass"`) whose reflection cannot map one field annotation collapse to `kind: "unknown"` in the descriptor (`pipelex/pipelex/codegen/native_expansion.py`), so a file field beneath one is invisible to this walk while the template, reflecting the real Pydantic class, still rendered it. That is a `pipelex` fidelity bug in `build_input_form`, filed as a program member; until it lands such a value passes through and the run reports the unresolved path.
- The invalid arm of the validate report never carries the descriptor, which is correct: there is nothing to prepare for a closure that does not load.
- The manifest-only `main_pipe` gap under "Pipe selection": a `method_ref` package whose entry pipe is named only in its manifest needs an explicit `pipe_ref` until the report's typed default ships.

## Alternatives rejected

- **Keep the build route and expand `method_id` client-side** (the first draft). Not a pass-through, two round trips, and it keeps the SDK's runtime path on a route the program retires.
- **Add `/build/inputs` to the platform's `method_id` sniff table.** Three rows and a `current_user` in three handlers — cheap, but a capability on a route being dropped, needing a platform deploy, for a uniformity that moving onto `validate` delivers without it. The program keeps it as a decision item (interim or skip; the recommendation is skip).
- **Serve `inputs` as a `/v1/codegen` kind.** Contradicts the codegen contract's `lock` promise, which the spec calls durable and the route's tests pin; and the SDK would still be classifying by template shape.
- **A `views: ["inputs_template"]` on `validate`.** Unnecessary once the descriptor is the classifier; the template is a presentation of the descriptor and the program projects it client-side (an `mthds` helper) for the consumers that show one to a person or an agent.
- **`pipe_io_contracts` JSON Schema as the classifier.** It marks Image/Document only at the top level through the sibling `concept_ref`; nested positions carry no annotation, and the standard says concept identity is never sniffed from schema shape.

## The two SDKs in step

`pipelex-sdk-python` (`L-260829-8a25d5`) lands the same surface: `prepare_inputs(client, *, files=None, method_ref=None, method_id=None, pipe_ref=None, inputs)`, exactly one, empty-as-absent, the same descriptor walk over `validate(..., views=["input_form"])`, the same pipe selection and the same outcomes. Because `build_inputs` and `BuildInputsRequest` exist there only to back `prepare_inputs`, that item deletes them. The first draft's note that Python would need a source-parser port is void: nothing is expanded client-side any more.

## Consumers

- `pipelex-mcp` (`L-260829-dfaed4`, a program member): `mthds_prepare_inputs` forwards all three selectors to `prepareInputs`, and its console arm — which resolves the signature itself through `buildInputs` — moves to `validate` + the descriptor the same way.
- `pipelex-starter-js`: not blocked; may switch its Dynamic tab to `prepareInputs({ method_ref | method_id })` at its own pace.
- `pipelex-plugins`, `pipelex-app`: no `prepareInputs` call sites.

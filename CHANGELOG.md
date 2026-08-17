# Changelog

## [v0.11.0] - 2026-08-17

### Changed

- **Breaking: `listMethods` returns one PAGE of summaries, not the whole catalog.** The signature is now `listMethods(query?) -> MethodPage` (`{items, nextCursor}`) instead of `listMethods() -> MethodData[]`, matching the platform's reshaped `GET /v1/methods`.

  This one is a **data-loss fix**, not a scaling improvement. The old endpoint issued a single DynamoDB query with no `LastEvaluatedKey` loop, and every row carried the method's whole `.mthds` bundle plus its generated Python. DynamoDB caps a query page at 1 MB, so the response stopped at roughly 200–300 methods — and stopped *silently*: no error, no truncation flag, just a shorter array than the org actually owned. Methods disappeared from the UI and nothing said so. The endpoint is now served from a narrow index projection, so a page costs the same whether the org has 50 methods or 100,000.

  **Migrating:** code that rendered the returned array directly should read `page.items` (accepting the first 50) or follow `page.nextCursor`. Callers that genuinely want everything can drain the new `iterateMethods`, but it is O(catalog) by construction and should not back a user-facing list.

  `query.q` searches server-side over name + description across the whole catalog — filtering a single page client-side would be searching 50 of 10,000 and calling it a search.

- **Breaking (types): list rows are `MethodSummary`, not `MethodData`.** `mthds`, `python` and `updated_at` are absent, because none of them is in the index projection — and putting `mthds` back is what restored the truncation bug. Use `getMethod(id)` when you need a method's source. `updated_at`'s absence is deliberate too: the catalog is ordered by `created_at` (immutable — over a mutable sort key a cursor duplicates and skips rows), and displaying a timestamp other than the one it sorts by makes "newest first" unreadable.

### Added

- **`iterateMethods(query?)`** — an async iterator that follows the cursor **past empty pages**. A filtered page can legitimately come back empty with a live cursor: the platform applies `q` as a post-read filter over a bounded slice of the index per request, so `{items: [], next_cursor: "…"}` means "nothing matched in the slice I just read, keep going". Stopping there would silently drop every later match. It gives up only when the server stops advancing its cursor — a runaway ceiling on total pages exists but sits far beyond any real catalog, and **throws** rather than returning, because a caller that asked for everything and got a partial answer with no error is the very bug this release removes. (`iterateRuns` may stop on an empty page: its date bounds are index key conditions, so a run page is never empty-with-a-cursor. The difference is the server, not the client.) It is an iterator, for callers that genuinely want the whole catalog: `for await (const m of client.iterateMethods())`. Deliberately **not** a `listAllMethods(): Promise<MethodSummary[]>`, for the same reason `iterateRuns` is an iterator: an all-at-once helper needs a page cap, and a cap means silently returning a truncated list — the exact failure paging exists to remove.
- `MethodSummary`, `MethodPage`, `ListMethodsQuery` and `MethodDeletionState` are exported.
- **`MethodSummary.deletion_state`** is surfaced on list rows. It was already on the wire but missing from the SDK's types, so consumers were relying on structural assignment to reach it. A method mid-erasure stays in the list — so the UI can render it as "Deleting…" — while `getMethod` refuses it with a 409.

## [v0.10.0] - 2026-08-12

### Changed

- **Breaking: `listRuns` returns one PAGE, not the whole history.** The signature is now `listRuns(methodId, query?) -> RunPage` (`{items, nextCursor}`) instead of `listRuns(methodId) -> PipelineRun[]`, matching the platform's reshaped `GET /v1/runs`. The old call read the method's entire run history on every invocation — the API paged a DynamoDB partition to exhaustion and sorted in memory, which cost ~150 sequential round trips at 5,000 runs and would not complete at 100k. The endpoint is now served from a time-ordered index, so a page costs the same whether the method has 50 runs or 100,000.

  **Migrating:** code that rendered the returned array directly should read `page.items` (accepting the first 50) or follow `page.nextCursor`. Callers that genuinely want everything — an export, a report — can drain the new `iterateRuns`, but it is O(history) by construction and should not back a user-facing list.

  `query.createdFrom` / `query.createdTo` filter server-side as index key conditions, so a bounded page genuinely reads less. They are **instants, not days**: ISO-8601 with a UTC offset, and a naive timestamp is a 400. Only the caller knows which timezone's day it means — it is the one rendering the rows — so it converts its own day boundaries rather than having the API guess, which is what made a bare `YYYY-MM-DD` ambiguous.

### Added

- **`iterateRuns(methodId, query?)`** — an async iterator that follows the cursor, for callers that genuinely want the whole history: `for await (const run of client.iterateRuns(id))`. Deliberately **not** a `listAllRuns(): Promise<PipelineRun[]>`. An all-at-once helper needs a page cap so a misbehaving server cannot spin it forever, and a cap means silently returning a truncated list — 6,000 runs quietly yielding 5,000, from a method called "all". That is the same failure paging was introduced to remove. Streaming has no cliff: it yields until the server says there is no more, the caller `break`s whenever it likes (a search that hits on page one never fetches page two), and only one page is ever in memory. `Array.fromAsync` makes materialising the lot an explicit choice.
- **`getRunDetail(runId)` — `GET /v1/runs/{id}`**, the only call that returns `mthds_contents` (what the run actually executed) and `inputs`. It is deliberately not on the status read, which pollers hit every few seconds, nor on the list, where the bundle would be multiplied by the page size. The bundle matters because a run is not reproducible from its `method_id`: a caller may run an editor buffer that was never saved.
- `RunPage`, `RunDetail`, `RunErrorReport` and `ListRunsQuery` are exported.
- **Breaking (types): `PipelineRun.method_id` and `.pipe_code` are now `string | null`.** Both are `str | None` on the API and both really are null in practice — an ad-hoc run (started from an inline bundle) belongs to no stored method, and `pipe_code` is null when the runner resolved the pipe from the bundle's `main_pipe`. The old required types could not represent a real response, so consumers narrow instead of trusting a promise the wire never made.

## [v0.9.0] - 2026-07-24

### Fixed

- **`prepareInputs` now accepts the explicit `{ concept, content }` input envelope, not only compact values.** An agent that fills the explicit template `buildInputs({ explicit: true })` returns — the default template shape the hosted console and MCP hand out — can now hand it straight back to `prepareInputs`. Previously every file-bearing envelope position threw `InputPreparationError: Unsupported value at a file input … got object`, breaking the `buildInputs(explicit) → fill → prepareInputs` round-trip. Per input, the caller may submit either the compact value or the `{ concept, content }` envelope (a plain object whose keys are exactly `concept` + `content`, matching the runtime's `_is_explicit`); the envelope's `content` is interpreted identically and preserved on output, so the concept annotation rides through to the run — the runtime accepts it. Nested / list / structured file positions and mixed compact+envelope inputs are all handled. See [`docs/input-preparation.md`](./docs/input-preparation.md).

## [v0.8.0] - 2026-07-24

### Added

- **`python` on the methods catalog model.** `MethodData` and `MethodWriteInput` gain an optional `python` field — the custom PipeFunc Python that travels with a stored method — typed as `MethodFile[]` (`{ name, content }`), so a `method_id`-run client can round-trip stored Python. On the wire it is the serialized `[{ name, content }]` catalog string; the client (de)serializes it at the boundary via `mthds/protocol`'s canonical `parseMethodFiles`/`serializeMethodFiles` (one owner of the format, no per-consumer parser mirror). Three-way on a `PUT`: **omit** preserves the stored Python (nothing sent), an **empty array** `[]` clears it (serialized to the `""` sentinel), a **non-empty array** replaces it. Raises the `mthds` floor to `^0.22.0` (the release that exports the `MethodFile` serialization).

## [v0.7.0] - 2026-07-24

### Added

- **Method-bundle transport on `execute` / `start`: run a method whose custom PipeFunc Python travels with it.** A run can now carry the whole method — the `.mthds` plus its `funcs/*.py`, `structures/*.py` and an optional `requirements.txt` — instead of only the inline `mthds_contents` text, so a method with custom Python is runnable through this SDK. Two equivalent, mutually exclusive encodings on the run options: `files` (a `{ relativePath: text }` map) and `bundle_b64` (the same bundle as a base64 zip). A bundle is self-contained, so it satisfies the "something to run" precondition on its own — neither `pipe_code` nor `mthds_contents` is required beside it, and a bundle-only call is now accepted rather than rejected as under-specified. The bundle is forwarded on the durable `start` path **and** on the blocking `execute` fallback, so a bare runner reached through `startAndWaitForResult` runs the same method as a hosted one.

  Run-source rules are enforced from the standard rather than restated here: `assertExclusiveRunSources` and `hasBundlePayload` are imported from `mthds/protocol` (new in `mthds` 0.21.0), so this client and the MTHDS runners cannot drift on which combinations they reject. Combining the two encodings, or either encoding with non-empty `mthds_contents`, raises `PipelineRequestError`. Exclusivity keys off **presence** (supplying `files: {}` alongside `bundle_b64` is still two encodings) while the run-source precondition keys off **runnability** (an empty encoding carries no method, so it is neither shipped on the wire nor counted as something to run). `files`, `bundle_b64`, and the client-only `bundleMain` entrypoint hint are all reserved keys on the `extra` passthrough — `extra` merges last into the body, so smuggling one through it would overwrite the validated fields, bypass the exclusivity check, or leak a never-serialized hint onto the wire; `buildExtensions` rejects any of them. `buildExtensions` also strips prototype-pollution keys (`__proto__` / `constructor` / `prototype`) so an `extra` populated from untrusted JSON never carries a pollution gadget on the wire. A bundle-carrying `start` is given the blocking path's upload timeout rather than the short poll timeout, so a large bundle can't time out on the durable path yet succeed on the fallback.

  Because the barrel re-exports `mthds/protocol`, both predicates are also available to consumers directly from `@pipelex/sdk`.

### Changed

- **Raised the `mthds` floor to `^0.21.0`** (was `^0.19.0`), adopting the method-bundle run-source surface and the protocol-level run-source predicates the transport above is built on.

## [v0.6.0] - 2026-07-23

### Added

- **By-id closure resolution: prepare and build inputs from a stored `method_id`.** `prepareInputs` and `buildInputs` now accept the method closure as a stored catalog `method_id` in place of inline `files` — `client.prepareInputs({ method_id, pipe_ref?, inputs })` and `client.buildInputs({ method_id, pipe_ref?, format?, explicit? })`. `method_id` is a client-side convenience, not a wire field: it is resolved to inline `files` via the new `getMethodClosure` before the request reaches the network, so a by-id call produces exactly the same result as the equivalent inline-`files` call and `method_id` never travels on the wire (it is distinct from the reserved `BuildRequestBase.method_ref` registry reference — that one still 501s). Supply `files` or `method_id`, never both — the either/or is a compile-time invariant (`PrepareInputsRequest` and `BuildInputsRequest` both forbid the over-specified `{ files, method_id }`), backed by runtime guards that reject both the degenerate neither-given and the over-specified both-given cases before any closure is resolved (so an untyped caller never silently gets `method_id` preferred over inline `files`). By-id resolution requires an API key (the catalog is org-scoped to the key's org). New exported client param type `BuildInputsByMethodId`. See [`docs/input-preparation.md`](./docs/input-preparation.md).
- **`getMethodClosure(methodId)` on `PipelexApiClient`** — resolve a stored method's id into its runnable, provenance-labelled MTHDS closure (`MthdsFileItem[]`, each file's `source` set to the method id). A client-side semantic layer over `getMethod` (the platform has no route that returns a parsed closure): it fetches the method, parses its polymorphic `mthds` source, and labels each file. An unknown or foreign-org id surfaces as the `getMethod` `404` (`ApiResponseError`, `code: "not_found"`); a real in-org method whose source parses to nothing throws the new `EmptyMethodSourceError`.
- **`methodSourceToContents(mthds)` — exported canonical source parser.** Turns a stored method's polymorphic `mthds` field — raw single-bundle text XOR a JSON `{ name, content }[]` file array — into a flat list of file contents, dropping blank entries. A verbatim port of the platform's `_method_source_to_contents`, so the SDK and the runtime read a stored source identically. Exported from the barrel for consumers that need the parse without the fetch (`getMethodClosure` is the fetch-and-parse convenience over it, and `pipelex-mcp` can retire its own parser mirror once it adopts this).
- **`EmptyMethodSourceError`** (extends `InputPreparationError`, carries `methodId`) — a by-id closure resolution found the stored method but its source parses to no runnable content (the row exists, no runnable source yet). It joins the input-preparation failure family (catch `InputPreparationError` to handle any preparation failure), and is deliberately distinct from the `ApiResponseError` `404` raised for an unknown or foreign-org id.
- **`MethodData` read-model fields: `org_id`, `created_by_user_id`, and a server-derived `description`.** The methods read model now carries the org and creator ids present on every `GET`/list response, plus `description` — parsed read-side by the platform from the bundle's top-level `description` key (present on reads, absent from the write contract, so typed `string | null | undefined`). Additive; the `MethodWriteInput` create/update payload is unchanged.

### Changed

- **Removed `deleteMethod` (breaking).** The client method wrapped `DELETE /v1/methods/{id}`, a route the hosted platform does not have and will not add by design — deletion of a saved method is an explicit product decision, not a default the SDK should imply. Callers relying on it must drop it; there is no replacement route.

## [v0.5.1] - 2026-07-22

### Security

- **Bumped the transitive dev dependency `brace-expansion` to a patched release (CVE-2026-13149 / GHSA-3jxr-9vmj-r5cp).** The vulnerable `5.0.6` copy pulled in via `@typescript-eslint` — exponential-time expansion of consecutive non-expanding `{}` groups, a DoS that can stall the calling thread — is updated to `5.0.7`; the unaffected top-level `1.x` copy moves to its latest patch in the same lockfile update. Lockfile-only change with no effect on the published runtime surface: `brace-expansion` is dev-only and is never shipped in `@pipelex/sdk`.

## [v0.5.0] - 2026-07-22

### Added

- **Input preparation: `uploadFile` and `prepareInputs` (hosted upload capability).** Two higher-level operations over the raw `upload()` wire call. `client.uploadFile(asset, options?)` uploads one local asset — `Blob`/`File`/`ArrayBuffer`/`Uint8Array` in every runtime, a filesystem path string in Node only (it fails instructively elsewhere) — and returns an `UploadRecord` (`uri`, `contentType`, `size`, `filename`) assembled client-side. `client.prepareInputs({ files, pipe_ref?, inputs })` resolves the target pipe's declared signature from the explicit inputs template, interprets the caller's compact `inputs` top-down against it (the file signal is the canonical Image/Document content shape — a `{url:…}` dict — mirroring the runtime's `input_normalizer`), uploads the file-bearing values, and returns `PreparedInputs`: a copy-on-write rewrite of `inputs` with each asset reference replaced by canonical content carrying `pipelex-storage://` in `url`, plus one `UploadRecord` per prepared asset. HTTP(S) URLs and existing `pipelex-storage://` URIs pass through unchanged; data URLs and local/byte sources are uploaded; the same source referenced twice uploads once (dedup by source identity); all failures are raised before any run is created. Failures are typed per category: `InvalidLocalSourceError`, `RejectedAssetError`, `UnsupportedUploadCapabilityError`, `UploadAuthenticationError`, `UploadTransportError` (all extend `InputPreparationError`). `prepareInputs` takes the method closure as inline `files`; catalog `method_id` resolution and opt-in `http(s)` ingest are deferred and additive. See [`docs/input-preparation.md`](./docs/input-preparation.md).
- **Typed run usage: `RunResults.tokens_usages` + `RunResults.usage_assembly_error`.** The per-call usage records a run produces — token counts by category, the server-computed `cost` in USD, model name and id, the pipe that made the call, job-kind fields and timing, for LLM and img-gen/extract/search calls alike — are now first-class typed fields. Records are typed by a new exported `TokensUsageRecord` interface (`src/runs.ts`) mirroring the wire contract specified in the MTHDS protocol spec. Both paths populate the pair: the hosted durable path reads it off `GET /v1/runs/{id}/results` (which unpacks the runner's `tokens_usages.json` artifact), and the blocking fallback lifts the same pair out of the execute response's extension-open `pipe_output` — so `result.tokens_usages` reads the same regardless of which path ran.

  Note that the rate table (`unit_costs`) no longer crosses the wire: a record now carries the computed `cost` for the call instead, which is null when the model has no rate table at all (own-GPU, mock, dry run) and `0` when a rate table priced it at zero. There is no run-level aggregate — sum the records.

  `tokens_usages` is null whenever usage assembly produced no list (it was off, it broke, or the run was delivered before the artifact existed) and `[]` when assembly ran and no inference happened; `usage_assembly_error` is the only field separating a broken assembly from an off one. `TokensUsageRecord` keeps every field optional and carries an index signature, so durable artifacts written before the contract shipped — relayed verbatim, never migrated — still type-check: `cost` and `pipe_code` arrive absent, and the legacy `job_metadata` / `unit_costs` stay reachable. Enum-ish fields (`model_type`, `job_category`, `unit_job_id`) are open sets typed as plain `string`, so runtime enum churn stays non-breaking.

### Changed

- **`RunResults.pipe_output` is now `DictPipeOutput | null`, was `Record<string, unknown> | null` (breaking).** The blocking path already had the concrete shape and widened it away; it now carries the typed value straight through. Read the working memory as properties — `result.pipe_output!.working_memory.root["out"]!.content` — rather than casting. The durable path still leaves it null.
- **`DictPipeOutput` is now extension-open** (gains `[extension: string]: unknown`), matching its Python counterpart `DictPipeOutputAbstract`, which has always been `extra="allow"`. The runner rides Pipelex extension fields on the pipe output — the usage pair is the current example — so a closed type forced every reader to cast the whole value away and left the two SDK mirrors of one wire shape disagreeing on whether it was closed. Widening only; existing reads are unaffected.

## [v0.4.0] - 2026-07-15

### Added

- **Tools routes (`lint` and `format`)**: Added `PipelexApiClient.lint(content, source?)` and `PipelexApiClient.format(content, options?)` for the new `/v1/lint` and `/v1/format` endpoints, providing single-file static diagnostics and canonical formatting without a full bundle load or dry-run. Both follow `validate`'s discipline: malformed content is a produced verdict on a `200` carrying `diagnostics[]` — never a thrown error — while a no-verdict condition (malformed body, malformed formatter `options`, auth, a server fault) is non-2xx and surfaces as the typed `ApiResponseError`. New exported wire types: `Diagnostic`, `DiagnosticKind`, `DiagnosticRange`, `LintResponse`, `FormatResponse`. `lint` is the cheap single-file check and does not replace `validate`, which loads the bundle, resolves across files, and dry-runs the pipes.
- **PostToolUse hook bundle**: Introduced a dependency-free ESM hook bundle (`dist-hooks/check.mjs`, built via `npm run build:hook` from new `src/hooks/` sources) that agent plugins (first consumer: `pipelex-plugins`) vendor as a static hook asset. It runs local lint/format via `@pipelex/tools-wasm` (offline, credential-free, format writes back in place), then fetches the full bundle verdict from `POST /v1/validate` through this SDK, forwarding the server-rendered Markdown as the block reason, subject to the hook's output cap. Bundle files are gathered recursively from parent directories with caps — on overflow the validate stage reads as unavailable rather than risking a false block on an under-supplied bundle. Fail-open posture throughout: a missing `PIPELEX_API_KEY`, network faults, timeouts, or any non-2xx silently skip the validate stage while the local lint/format verdicts still apply. To bundle an unreleased engine build, point `PIPELEX_TOOLS_WASM_PATH` at a `vscode-pipelex/js/tools-wasm` checkout.
- **Live E2E testing pipeline**: Added an E2E test suite (`tests/e2e/*.e2e.ts`, own `vitest.e2e.config.ts`) that runs against a live `pipelex-api` server via `make test-e2e` (or `make te`), excluded from `make test` so CI never needs a server; target a specific instance with `PIPELEX_E2E_BASE_URL` (default `http://localhost:8081`). It verifies the real endpoint contracts the unit mocks cannot: `lint` / `format` / `validate` verdicts on clean and malformed bundles, and the full build-route surface (`tests/e2e/build.e2e.ts`) — selector defaulting and both un-defaultable arms, source-label threading, the `format`→field mapping, the stamped structures projection, the `200` invalid arm, and the `422` / `501` no-verdict arms — reusing the server's own build-route fixtures so both sides test one closure.
- **Documentation**: Added `docs/build-routes.md` detailing the shared envelope, discriminated verdicts, and format-specific payloads of the `/v1/build/*` routes. Updated `docs/architecture.md` to reflect the new testing layers, tools routes, and hook bundle.
- **Cooperative cancellation on the build/tools and validate routes**: `buildRunner` (and the whole extension tier it shares — `lint`, `format`, `buildInputs`, `buildOutput`, `concept`, `pipeSpec`) accepts `signal?: AbortSignal` alongside `timeoutMs`, and `validate` / `validateFiles` gain the same `{ timeoutMs, signal }` options — a caller that abandons a long dry-run sweep or bundle validation cancels the request instead of waiting out the timeout. A caller abort propagates its reason untouched, matching the run-lifecycle routes. The post-edit hook now bounds its validate call through these options, so a timed-out hook actually aborts the in-flight request.

### Changed

- **Raised the `mthds` dependency floor to `^0.19.0` (Breaking)**: That release is where the MTHDS side of the `/v1/build/*` migration landed — the `files[]` envelope, the qualified `pipe_ref`, and the discriminated build verdicts this SDK implements below — so an older `mthds` no longer satisfies the protocol surface the client's route shapes are typed against.
- **Build routes use the `files[]` envelope (Breaking)**: `buildInputs`, `buildOutput`, and `buildRunner` now accept the closure as `files: [{content, source?}]` XOR a reserved `method_ref`, plus an optional qualified `pipe_ref` (`domain.pipe_code`) that defaults to the closure's `main_pipe` — replacing the retired `mthds_contents` and bare `pipe_code`. `allow_signatures` survives only on `buildRunner`, the one build route that still dry-runs the closure. The per-file `source` label rides through to the diagnostics, so an invalid verdict can name the file that caused it when attribution is available. _Migration_: change `{mthds_contents: [src], pipe_code: "echo"}` to `{files: [{content: src}], pipe_ref: "smoke.echo"}` (or drop `pipe_ref` to default to `main_pipe`).
- **Build routes return discriminated 200 verdicts (Breaking)**: Following `validate`'s discipline, an unresolvable closure is the successful product of the call — a `200` with `is_valid: false` and `validation_errors[]` — instead of throwing. Consumers must branch on `is_valid` before reading the payload arm. `BuildRunnerResponse` is now the union `BuildRunnerValidReport | CrateInvalidReport` (its valid arm carries `python_code` plus the stamped `structures` projection, replacing the old flat `{python_code, pipe_code, success, message}`), and `buildInputs` / `buildOutput` — previously typed `Promise<unknown>` — get the same treatment. New exported types: `InputsTemplateFormat`, `MthdsFileItem`, `BuildRequestBase`, `CrateInvalidReport`, `BuildInputsValidReport`, `BuildOutputValidReport`, `BuildRunnerValidReport`, `GeneratedArtifact`, `RunnerStructures`, `BuildInputsResponse`, `BuildOutputResponse`.
- **Build payloads follow the requested `format` (Breaking)**: `buildInputs` populates `inputs` for `format: "json"` (the default) and `inputs_toml` for `format: "toml"`; `buildOutput` populates `output` for `format: "schema"`/`"json"` and `output_python` for `format: "python"`. Unselected format fields are absent from the body rather than `null` — so the valid reports are discriminated unions on `format`, not interfaces with optional fields: narrowing on `format` hands you the selected field as required and makes the other statically unreachable. `buildInputs` also gains an `explicit` request flag that opts into the ceremonial `{concept, content}` envelope per input instead of the default light shape.

### Fixed

- **`buildRunner` timeout**: `buildRunner` no longer inherits the standard 30-second management timeout, which previously caused a false `ApiUnreachableError` for large closures that legitimately exceed 30s during dry-run — blaming the caller's network for a perfectly healthy server. It now has a dedicated 5-minute default, overridable per-call via `buildRunner(request, { timeoutMs })`; `lint`, `format`, `buildInputs`, `buildOutput`, `concept` and `pipeSpec` keep the 30s default, which is right for them.
- **Request timeout now covers the response body read**: the transport previously disarmed its timeout as soon as the response headers arrived, so a server that stalled mid-body could hang a request indefinitely past the advertised ceiling — and a failed body read was silently swallowed into an empty body. The timer and abort signal now stay armed until the body has fully arrived, and an aborted or failed read surfaces as the typed timeout/abort error. Applies to every route.
- **Build route error taxonomy**: Non-2xx responses on build routes (e.g., `422` for an unresolvable pipe selector — an unknown `pipe_ref`, or an omitted one on a closure that declares no `main_pipe`, or several — `501` for the reserved `method_ref`) now throw a typed `ApiResponseError` instead of a bare `Error` string, letting callers branch reliably on `ApiResponseError.status` instead of matching on prose. `concept` and `pipeSpec` ride the same helper and pick this up too.

## [v0.3.1] - 2026-07-10

### Changed

- Bumped the `mthds` dependency floor to `^0.18.0` (was `^0.16.0`), keeping it current with the latest published `mthds`. The intervening `mthds` releases are CLI/tooling changes — `0.17.0` adds the `mthds-agent inputs upload` subcommand and an `MthdsApiClient.uploadFile()` method; `0.18.0` adds Codex version detection and turns hook-disabling config keys into hard errors — none of which touch the `mthds/protocol` wire types `@pipelex/sdk` imports. The SDK's own code is unchanged, so this is a coordination floor; the green `make check` / `make test` run confirms the route shapes still type-check against `mthds@0.18.0`.

## [v0.3.0] - 2026-07-05

### Changed

- **One output accessor across both execution modes: `result.main_stuff` (Breaking).** `RunResults.main_stuff` was optional (`main_stuff?: unknown`) and callers had to fall back to `pipe_output` and shape-guess the main output on the blocking path. Leaning on the pipelex >= 0.37 main-stuff invariant (every completed run delivers a main stuff), the SDK now delivers a resolved, non-null main output on **both** paths under the same accessor. The durable path returns a `RunResults` whose `main_stuff` is the `main_stuff.json` S3 artifact; `execute()` now returns a **`PipelexExecuteResult`** (a `DictRunResultExecute` subtype) whose `.main_stuff` getter resolves the output out of the returned working memory via the response's `main_stuff_name`. Consumers read `result.main_stuff` directly on either path — no `main_stuff ?? pipe_output` fallback, no shape-guessing, no branching on which path ran. The full working memory still rides `pipe_output` (blocking path only) for consumers that want it. _(Migration: read `result.main_stuff` instead of `result.main_stuff ?? result.pipe_output`.)_

### Added

- **`PipelexExecuteResult`.** The blocking `execute()` result type — a `DictRunResultExecute` with a resolved `.main_stuff` accessor, so a blocking result reads its output the same way as a durable `RunResults`. `main_stuff_name` is declared as a typed field on this Pipelex-branded subtype (the neutral `mthds` wire model leaves it in its extension index signature).
- **`MissingMainStuffError`.** A completed run that cannot deliver a main stuff now throws this typed error (extends `PipelineRequestError`, carries `runId`) instead of silently yielding a null output: the hosted results endpoint answered a `200` with a null `main_stuff`, or a blocking `execute` response named a `main_stuff_name` absent from its working-memory root. A falsy-but-present main stuff (empty array, `0`) is a valid output and does not throw.

## [v0.2.1] - 2026-07-03

### Fixed

- **CJS consumers can now `require("@pipelex/sdk")`.** The package is ESM-only (`"type": "module"`), but its `exports` map only declared `import` and `types` conditions, so `require()` failed with `No "exports" main defined`. Added a `default` condition pointing at the existing ESM build (`dist/index.js`) — Node's `require(ESM)` support (stable since Node 20.19 / 22.12) loads it without a separate CJS build. Also reordered the `exports` conditions so `types` precedes `import`/`default`, matching TypeScript/Node's condition-ordering convention.
- Raised the `engines.node` floor to `>=22.12.0` (was `>=22`) — the earliest Node 22.x release with unflagged `require(ESM)`, which the fix above depends on.

## [v0.2.0] - 2026-07-02

### Changed

- **Breaking — `PipelexApiClient` constructor option renamed `apiToken` → `apiKey`.** Aligns the option name with the `PIPELEX_API_KEY` environment variable it falls back to (matching the same rename in `mthds`'s `MthdsApiClient`). Update `new PipelexApiClient({ apiToken })` call sites to `new PipelexApiClient({ apiKey })`. The wire (the `Authorization: Bearer` header) and the env-var fallback are unchanged.
- **Breaking — API base URL env var renamed `PIPELEX_API_URL` → `PIPELEX_BASE_URL`.** For consistency with the internal `baseUrl` naming and coordinated with the `MTHDS_API_URL` → `MTHDS_BASE_URL` rename in the `mthds` clients. There is no read alias — update any environment or deployment that sets `PIPELEX_API_URL`.
- Bumped the `mthds` dependency floor to `^0.16.0` (was `^0.15.0`), adopting its `MthdsApiClient` `apiToken` → `apiKey` and `MTHDS_API_URL` → `MTHDS_BASE_URL` renames — the source of the two breaking renames above.

## [v0.1.5] - 2026-06-30

### Changed

- Bumped the `mthds` dependency floor to `^0.15.0` (was `^0.14.0`). `mthds@0.15.0` removes the Pipelex-API `/v1/validate` narrowing from its surface (`MthdsApiClient.validate()` now returns the standard's neutral `ValidationResult`), making `@pipelex/sdk` the sole owner of `PipelexValidationResult` and its arms. The SDK's own code is unchanged — it imports only the `mthds/protocol` wire types, which are identical across the bump — so this is a coordination floor that keeps the brand boundary unambiguous (only one package exports the Pipelex narrowing).

## [v0.1.4] - 2026-06-30

### Changed

- Bumped the `mthds` dependency floor to `^0.14.0` (was `^0.13.1`), picking up the latest published MTHDS protocol wire types.

### Added

- `make use-local` / `make use-npm` (shorthands `make ul` / `make un`) to switch the `mthds` dependency between a file link to the sibling `../mthds-js` checkout for live development and the published npm package (latest by default, or a pinned `VERSION=x.y.z`).

## [v0.1.3] - 2026-06-28

### Changed

- Raised the minimum supported Node.js to 22 (`engines.node: ">=22"`). Node 18 (end-of-life April 2025) and Node 20 (end-of-life April 2026) are past maintenance and are no longer supported; the floor now matches the `@types/node` major the SDK is built against. npm only warns on an engine mismatch unless the consumer sets `engine-strict`, so this is a support-policy change rather than a hard install gate.
- Bumped the `mthds` dependency floor to `^0.13.1` (was `^0.13.0`); its `0.13.1` release raises its own Node.js floor to 22 in lockstep with this SDK.
- CI now builds and tests on Node.js 22 (was Node.js 20).
- Migrated the remaining workflow actions off the deprecated Node.js 20 runtime so they run on Node.js 24 natively: `actions/create-github-app-token` (v1 → v3), `actions/upload-artifact` (v4 → v7), and `actions/download-artifact` (v4 → v8). The third-party `contributor-assistant/github-action` still ships a Node.js 20 runtime and will emit the deprecation warning until an upstream release migrates it.

## [v0.1.2] - 2026-06-28

### Changed

- CI: bumped `actions/checkout` and `actions/setup-node` from v4 to v5 across all workflows. The v4 releases bundle the deprecated Node.js 20 runtime (force-run on Node.js 24 with a deprecation warning); v5 targets Node.js 24 natively. The SHA-pinned release checkout now points to the v5.0.1 commit.

### Fixed

- The exported `SDK_VERSION` constant was stale (`0.1.0`) because the release flow never bumped it — consumers reading it for diagnostics or compatibility checks saw a version that disagreed with the published npm version. It is now bumped in lockstep with `package.json` and guarded by a test that asserts the two stay equal.

## [v0.1.1] - 2026-06-28

### Changed

- The `mthds` dependency is now consumed from npm as a published version (`^0.13.0`) instead of a GitHub branch ref. This pins the upstream MTHDS protocol types to a released package rather than a moving branch.

## [v0.1.0] - 2026-06-27

### Added

- Initial release of `@pipelex/sdk` — the TypeScript SDK for the Pipelex hosted API. House-style toolchain mirrored from `mthds-js`: ESM-only `tsc` build (NodeNext, strict), Vitest 4 with v8 coverage, ESLint 9 flat config, Prettier 3, dependency-cruiser boundary enforcement (`@pipelex/sdk → mthds` only via the `mthds/protocol` subpath), and a `Makefile` task surface. CI parity (quality checks, npm OIDC trusted publishing, changelog/version guards).
- `PipelexApiClient` — the Pipelex product client. Owns its own `request()` pipeline (auth, base URL, timeouts/abort, RFC 7807 problem-details parsing) and implements the MTHDS protocol-execution routes using `mthds/protocol` types (`implements MTHDSProtocol<DictPipeOutput>`): `execute`, `start`, `validate` (returns the `PipelexValidationResult` 200-diagnostic union), `validateFiles`, `models`, `version`. Adds the Pipelex build helpers (`/v1/build/*`) and the durable run lifecycle (`getRunStatus` / `getRunResult` / `waitForResult` / `startAndWaitForResult`, with hosted-vs-bare runner self-healing). Env vars `PIPELEX_API_KEY` / `PIPELEX_API_URL`; default base URL `https://api.pipelex.com`.
- Typed errors (`ApiResponseError`, `ApiUnreachableError`, `PipelineExecuteTimeoutError`, run-lifecycle errors), all deriving from the protocol-base `PipelineRequestError` re-exported from `mthds/protocol`. `ApiResponseError` carries the product routes' stable RFC 9457 `code` discriminant.
- Pipelex product routes on `PipelexApiClient` — the hosted management surface (user profile, methods catalog CRUD, organizations, billing, Pipelex API keys, gateway API key, onboarding, storage, runs list/update). All ride the shared `requestProduct<T>` helper (30s management timeout, empty-body tolerant) and the same `{base}/v1/*` + `Authorization: Bearer` + org-from-JWT contract; non-2xx `problem+json` maps to `ApiResponseError` with the structured `code`. Thin snake_case wire models in `product-models.ts`.

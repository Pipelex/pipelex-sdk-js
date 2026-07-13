# Changelog

## [Unreleased]

### Changed

- **The `/v1/build/*` routes ride the shared `files[]` envelope and return typed verdicts (breaking).** `buildInputs`, `buildOutput` and `buildRunner` now take the closure as `files: [{content, source?}]` **XOR** a reserved `method_ref`, plus an optional **qualified** `pipe_ref` (`domain.pipe_code`) that defaults to the closure's `main_pipe`. The retired `mthds_contents: string[]` + bare `pipe_code` are gone, and `allow_signatures` survives only on `buildRunner` — the one build route that still dry-runs the closure. The per-file `source` label is the point of the migration: it rides through to the diagnostics, so an invalid verdict names the file that caused it. *(Migration: `{mthds_contents: [src], pipe_code: "echo"}` → `{files: [{content: src}], pipe_ref: "smoke.echo"}`, or drop `pipe_ref` to default to `main_pipe`.)*
- **Each build route returns a discriminated 200 verdict, not a bare payload (breaking).** They follow `validate`'s discipline: an unresolvable closure is the *successful product* of the call, so it comes back as a **200** `is_valid: false` with `validation_errors[]` — never a thrown error. **Branch on `is_valid` before reading the arm**; a consumer that only catches throws will render a success over an unusable result. `BuildRunnerResponse` is now the union `BuildRunnerValidReport | CrateInvalidReport` (its valid arm carries `python_code` plus the stamped `structures` projection, replacing the old flat `{python_code, pipe_code, success, message}`), and `buildInputs` / `buildOutput` gain the same treatment — they were typed `Promise<unknown>`. New exported types: `InputsTemplateFormat`, `MthdsFileItem`, `BuildRequestBase`, `CrateInvalidReport`, `BuildInputsValidReport`, `BuildOutputValidReport`, `BuildRunnerValidReport`, `GeneratedArtifact`, `RunnerStructures`, `BuildInputsResponse`, `BuildOutputResponse`.
- **The payload field follows the requested `format`.** On `buildInputs`, `format: "json"` (the default) puts the parsed template in `inputs`, while `format: "toml"` puts raw text in `inputs_toml` — TOML cannot ride as a parsed object without losing its concept comments and key order. `buildOutput` splits the same way: `schema` (default) and `json` yield an object in `output`, `python` yields source text in `output_python`. The field the format did not select is **absent** from the body, not `null`. `buildInputs` also gains `explicit` (the ceremonial `{concept, content}` envelope per input).

### Fixed

- **The build routes now surface their non-2xx arms as the typed `ApiResponseError`.** They were the only `/v1` routes still throwing a bare `Error` carrying just a message string, which was defensible when they returned untyped payloads and is not now that they have a real no-verdict taxonomy: `422` for an unresolvable pipe selector (an unknown `pipe_ref`, or an omitted one on a closure that declares no `main_pipe` — or several), `501` for the reserved `method_ref`. Callers branch on `ApiResponseError.status` instead of matching on prose. `concept` and `pipeSpec` ride the same helper and pick this up too.

### Added

- **E2E coverage of the build routes against a live server (`tests/e2e/build.e2e.ts`).** The unit suite cannot catch a wrong field name — every mock in the repo agrees with the client — so these drive `buildInputs` / `buildOutput` / `buildRunner` against a real pipelex-api: selector defaulting and both un-defaultable arms (no `main_pipe`, several), source-label threading, the `format`→field mapping, the stamped structures projection, the 200 invalid arm, and the 422 / 501 no-verdict arms. Reuses the server's own build-route fixtures so both sides test one closure.
- **E2E test suite against a live pipelex-api (`make test-e2e`).** New `tests/e2e/` suites (distinct `.e2e.ts` suffix, own `vitest.e2e.config.ts`) exercise `lint`, `format`, and `validate` end-to-end with correct and malformed MTHDS bundles — no fetch mocks. They verify the diagnostic-endpoint contract for real: clean bundles lint with zero diagnostics and format to themselves idempotently, malformed bundles come back as 200 verdicts (`diagnostics[]` / `is_valid: false` + `validation_errors[]`), and malformed formatter options surface as a 422 `ApiResponseError`. Excluded from `make test` so CI never needs a server; target a specific instance with `PIPELEX_E2E_BASE_URL` (default `http://localhost:8081`).
- **`lint()` and `format()` — the pipelex-api tools routes.** `PipelexApiClient.lint(content, source?)` (`POST /v1/lint`) returns the static diagnostics of one `.mthds` file (syntax / schema / semantic), and `PipelexApiClient.format(content, options?)` (`POST /v1/format`) returns the canonically formatted content plus a `changed` flag and any diagnostics. Both are diagnostic endpoints like `validate`: malformed content is a produced verdict on a **200** carrying `diagnostics[]` — never a thrown error — while a no-verdict condition (a malformed body, malformed formatter `options` such as a non-numeric `column_width`, auth, a server fault) is non-2xx and surfaces as the typed `ApiResponseError`. New exported wire types: `Diagnostic`, `DiagnosticKind`, `DiagnosticRange`, `LintResponse`, `FormatResponse`. `lint` is the cheap single-file check and does not replace `validate`, which loads the bundle, resolves across files, and dry-runs the pipes.

## [v0.3.1] - 2026-07-10

### Changed

- Bumped the `mthds` dependency floor to `^0.18.0` (was `^0.16.0`), keeping it current with the latest published `mthds`. The intervening `mthds` releases are CLI/tooling changes — `0.17.0` adds the `mthds-agent inputs upload` subcommand and an `MthdsApiClient.uploadFile()` method; `0.18.0` adds Codex version detection and turns hook-disabling config keys into hard errors — none of which touch the `mthds/protocol` wire types `@pipelex/sdk` imports. The SDK's own code is unchanged, so this is a coordination floor; the green `make check` / `make test` run confirms the route shapes still type-check against `mthds@0.18.0`.

## [v0.3.0] - 2026-07-05

### Changed

- **One output accessor across both execution modes: `result.main_stuff` (Breaking).** `RunResults.main_stuff` was optional (`main_stuff?: unknown`) and callers had to fall back to `pipe_output` and shape-guess the main output on the blocking path. Leaning on the pipelex >= 0.37 main-stuff invariant (every completed run delivers a main stuff), the SDK now delivers a resolved, non-null main output on **both** paths under the same accessor. The durable path returns a `RunResults` whose `main_stuff` is the `main_stuff.json` S3 artifact; `execute()` now returns a **`PipelexExecuteResult`** (a `DictRunResultExecute` subtype) whose `.main_stuff` getter resolves the output out of the returned working memory via the response's `main_stuff_name`. Consumers read `result.main_stuff` directly on either path — no `main_stuff ?? pipe_output` fallback, no shape-guessing, no branching on which path ran. The full working memory still rides `pipe_output` (blocking path only) for consumers that want it. *(Migration: read `result.main_stuff` instead of `result.main_stuff ?? result.pipe_output`.)*

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

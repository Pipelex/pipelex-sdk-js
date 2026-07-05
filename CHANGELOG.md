# Changelog

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

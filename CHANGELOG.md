# Changelog

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

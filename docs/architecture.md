# Architecture — `@pipelex/sdk`

## Purpose

`@pipelex/sdk` is the Pipelex-branded product client for the hosted Pipelex API. It is the single import source for Node consumers (the webapp is the proving ground) that need to:

- run methods against the hosted runner (`execute` / `start`, run lifecycle, results),
- validate `.mthds` content (`validate`, returning the Pipelex `PipelexValidationResult` envelope),
- read the model deck and version handshake (`models` / `version`),
- and reach the Pipelex product surface (user profile, methods catalog, organizations, billing, API keys, gateway key, onboarding, storage).

## Dependency direction (one-way)

```
@pipelex/sdk  ──imports──►  mthds/protocol   (pure MTHDS wire types)
     ▲
     └── consumers (pipelex-app, ...)
```

- `@pipelex/sdk` depends on `mthds`, and only through the published **`mthds/protocol`** subpath. It never deep-imports `mthds` internals, and `mthds` never imports from `@pipelex/sdk`. `dependency-cruiser` enforces both directions.
- The client re-implements the official MTHDS protocol routes using MTHDS *types*; it owns its own `request()` pipeline (auth, base URL, retries/timeouts/abort, problem-details, observability). It does not delegate to `mthds`'s protocol client. Pinning route shapes to `mthds/protocol` types keeps them from silently diverging from the standard.

## Brand boundary

- **MTHDS-branded (lives in `mthds`):** protocol wire models, the standard `ValidationReport` / `ValidationResult` shapes, `.mthds` utilities, the `MthdsProtocolClient`.
- **Pipelex-branded (lives here):** `PipelexApiClient`, run store / durable lifecycle, build helpers, `PipelexValidationResult`, hosted-product typed errors, API keys / orgs / billing / methods catalog / storage / onboarding.
- Inside a Pipelex envelope, field names stay neutral (`bundle_blueprint`, `pipe_structures`, `graph_spec`) — Pipelex branding is reserved for genuinely runtime-specific envelopes.

## Wire conventions

- Base URL from env (default `https://api.pipelex.com`); every route under `/v1/*`.
- Auth: `Authorization: Bearer <token>`; organization resolved from the JWT `org_id` claim, not a header.
- A diagnostic verdict (e.g. `/v1/validate`) is a `200` discriminated on a body field (`is_valid`); non-2xx is reserved for "no verdict could be produced" (request-shape `422`, auth `401`/`403`, server `5xx`), carried as RFC 7807 `problem+json` and mapped to typed product errors.

## Module layout

Flat `src/` (mirrors `mthds-js`'s `runners/api` flatness — the SDK has one client, so no runner/registry abstraction):

- `client.ts` — `PipelexApiClient`: the `request()` pipeline (auth, base URL, timeouts/abort, problem-details parsing) and every route. `implements MTHDSProtocol<DictPipeOutput>` so the protocol-execution methods stay shaped like the standard.
- `models.ts` — Dict-serialized concretes (`DictStuff` / `DictWorkingMemory` / `DictPipeOutput` / `DictRunResultExecute`), the `/v1/validate` surface (`PipelexValidationResult` and `ValidationErrorItem`), and the `/v1/build/*` request/response models.
- `runs.ts` — the run-lifecycle types (`RunStatus`, `RunRead`, `RunResults`, `RunResultState`) and the single poll loop (`pollUntilResult`).
- `errors.ts` — typed errors; all derive from the protocol-base `PipelineRequestError` (re-exported from `mthds/protocol`) except `ClientAuthenticationError`.
- `index.ts` — the public barrel: `export * from "mthds/protocol"` (single import source for the standard surface) plus the client, models, run types, and errors.

## Client surface (current)

- **Protocol execution:** `execute`, `start`, `validate` (returns `PipelexValidationResult`), `validateFiles`, `models`, `version`.
- **Build helpers (`/v1/build/*`):** `buildInputs`, `buildOutput`, `buildRunner`, `concept`, `pipeSpec`.
- **Durable run lifecycle (hosted extension — NOT protocol):** `getRunStatus`, `getRunResult`, `waitForResult`, `startAndWaitForResult` (handshakes `/v1/version`, takes the durable start+poll path on a hosted deployment, and self-heals to the blocking `execute` against a bare runner).
- **Health:** `health` (origin-level `/health`).

The Pipelex product routes (user profile, methods catalog, organizations, billing, API keys, gateway key, onboarding, storage, runs list/update) land next.

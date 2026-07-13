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
- Inside a Pipelex envelope, field names stay neutral (`bundle_blueprint`, `pipe_io_contracts`, `graph_spec`) — Pipelex branding is reserved for genuinely runtime-specific envelopes.

## Module format & packaging

The package is ESM-only (`"type": "module"`, `dist/index.js` built by `tsc` with `module: NodeNext`) — there is no separate CJS build. CJS consumers can still load it: the `exports` map declares a `default` condition alongside `import`, both pointing at the same ESM `dist/index.js`, so `require("@pipelex/sdk")` resolves through Node's `require(ESM)` support rather than a transpiled dual build. That support needs Node 20.19+ or 22.12+ (unflagged); `engines.node` is pinned to `>=22.12.0` to match the workspace's Node 22 floor. This only works because `dist/` has no top-level await — if that ever changes, `require()` of the module will throw and a real dual ESM+CJS build (or a `require`-only CJS entrypoint) would be needed instead.

Condition order in `exports` matters: `types` is listed first (TS/Node resolution convention — the type-checker looks at the first matching condition), then `import`, then `default` as the CJS fallback.

## Wire conventions

- Base URL from env (default `https://api.pipelex.com`); every route under `/v1/*`.
- Auth: `Authorization: Bearer <token>`; organization resolved from the JWT `org_id` claim, not a header.
- A diagnostic verdict (e.g. `/v1/validate`) is a `200` discriminated on a body field (`is_valid`); non-2xx is reserved for "no verdict could be produced" (request-shape `422`, auth `401`/`403`, server `5xx`), carried as RFC 7807 `problem+json` and mapped to typed product errors.

## Module layout

Flat `src/` (mirrors `mthds-js`'s `runners/api` flatness — the SDK has one client, so no runner/registry abstraction):

- `client.ts` — `PipelexApiClient`: the `request()` pipeline (auth, base URL, timeouts/abort, problem-details parsing) and every route. `implements MTHDSProtocol<DictPipeOutput>` so the protocol-execution methods stay shaped like the standard.
- `models.ts` — Dict-serialized concretes (`DictStuff` / `DictWorkingMemory` / `DictPipeOutput` / `DictRunResultExecute`), the `/v1/validate` surface (`PipelexValidationResult` and `ValidationErrorItem`), the tools surface (`Diagnostic` / `LintResponse` / `FormatResponse`), and the `/v1/build/*` request/response models.
- `product-models.ts` — the snake_case wire shapes for the hosted-product management routes (profile, methods catalog, organizations, billing, API keys, gateway key, onboarding, storage, runs list/update). Each interface models only the fields the product actually consumes — no speculative mirrors.
- `runs.ts` — the run-lifecycle types (`RunStatus`, `RunRead`, `RunResults`, `RunResultState`) and the single poll loop (`pollUntilResult`). `RunResults.main_stuff` (the resolved main output content) is always present for a completed run: on the hosted path it is the `main_stuff.json` S3 artifact; on the bare-runner blocking path the SDK resolves it from the returned working memory via the response's `main_stuff_name`, so both paths deliver the same shape. Consumers read `main_stuff` directly. The full working memory still rides `pipe_output` (blocking path only) for consumers that want it, and `graph_spec` rides the hosted path. A completed run that cannot deliver a main stuff throws `MissingMainStuffError`.
- `execute-result.ts` — `PipelexExecuteResult`, a `DictRunResultExecute` subtype that adds a resolved `.main_stuff` accessor (dug out of `pipe_output`'s working memory via the response's `main_stuff_name`, throwing `MissingMainStuffError` if unlocatable). `execute()` returns it, giving blocking and durable results the **same output accessor** — `result.main_stuff` — so callers never branch on which path ran. The neutral `mthds` wire model leaves `main_stuff_name` in its extension index signature; this Pipelex-branded subtype declares it as a typed field (Pipelex owns that concept). `mapRunResultToRunResults` reads that accessor too, keeping the resolution single-sourced.
- `errors.ts` — typed errors; all derive from the protocol-base `PipelineRequestError` (re-exported from `mthds/protocol`) except `ClientAuthenticationError`.
- `index.ts` — the public barrel: `export * from "mthds/protocol"` (single import source for the standard surface) plus the client, models, run types, and errors.

## Client surface (current)

- **Protocol execution:** `execute` (returns a `PipelexExecuteResult` with a resolved `.main_stuff`), `start`, `validate` (returns `PipelexValidationResult`), `validateFiles`, `models`, `version`.
- **Build helpers (`/v1/build/*`):** `buildInputs`, `buildOutput`, `buildRunner`, `concept`, `pipeSpec`.
- **Tools (`/v1/lint`, `/v1/format`):** `lint`, `format` — single-file static diagnostics and canonical formatting, served by any pipelex-api runner (no inference, no bundle load). Both are **diagnostic endpoints** like `validate`: a malformed `.mthds` file is a produced verdict on a **200** carrying `diagnostics[]`, never a thrown error — `format` additionally echoes the content back unchanged with `changed: false`. Only a no-verdict condition is non-2xx: a malformed body, **malformed formatter `options`** (e.g. a non-numeric `column_width` ⇒ 422), auth, or a server fault, all mapped to the typed `ApiResponseError`. `lint` is the cheap static check (syntax / schema / semantic); it does not replace `validate`, which loads the bundle, resolves across files, and dry-runs the pipes.
- **Durable run lifecycle (hosted extension — NOT protocol):** `getRunStatus`, `getRunResult`, `waitForResult`, `startAndWaitForResult` (handshakes `/v1/version`, takes the durable start+poll path on a hosted deployment, and self-heals to the blocking `execute` against a bare runner).
- **Health:** `health` (origin-level `/health`).

### Product routes (hosted management surface)

The hosted catalog/account routes the webapp drives. All ride the same `{base}/v1/*` + `Authorization: Bearer` + org-from-JWT contract as the protocol routes, go through the shared `requestProduct<T>` helper (30s management timeout, empty-body tolerant), and map a non-2xx RFC 9457 `problem+json` to a typed `ApiResponseError`. Consumers branch on the **structured `code`** (`conflict`, `not_found`, `pipelex_api_key_limit_reached`, …), never the HTTP status.

- **User profile:** `getMe` (`GET /v1/me`).
- **Methods catalog:** `listMethods`, `getMethod`, `createMethod`, `updateMethod` (rename = changed `name`), `deleteMethod`.
- **Organizations:** `listMemberships`, `createOrganization`, `renameOrganization` (`PATCH`). The org "switch" is a WorkOS-session op (`/api/active-org`), not a `/v1` route — out of SDK scope.
- **Billing:** `getSubscription`, `listPlans`, `listInvoices`, `createCheckout`, `changePlan` (409 `conflict` ⇒ no subscription), `getBillingPortal` (409 `conflict` ⇒ no subscription).
- **Pipelex API keys (`plx_sk_…`):** `listPipelexApiKeys`, `createPipelexApiKey` (409 `pipelex_api_key_limit_reached`), `revokePipelexApiKey`, `rotatePipelexApiKey`. The plaintext `api_key` is returned once, on create/rotate.
- **Gateway API key (LLM inference key):** `createGatewayApiKey` (the JSON body is always sent, even with `promo_code: null`), `getGatewayApiKey`.
- **Onboarding:** `submitOnboarding`.
- **Storage:** `resolveStorageUrl`, `upload` (JSON base64 — the multipart hop is browser→BFF only).
- **Runs list/update:** `listRuns` (by `method_id`), `updateRun` (admin/manual status patch). The status/results/start lifecycle routes live in the run-lifecycle section above.

## Testing

Two layers, split by whether a server is in the loop:

- **Unit suites (`tests/*.test.ts`, `make test`):** mock the fetch boundary (`vi.spyOn(globalThis, "fetch")`) and pin the client's wire behavior — URLs, request bodies, status→error mapping, poll semantics. These run everywhere, including CI.
- **E2E suites (`tests/e2e/*.e2e.ts`, `make test-e2e`):** no mocks — they drive a **live pipelex-api server** (`PIPELEX_E2E_BASE_URL`, default `http://localhost:8081`) and verify the diagnostic-endpoint contract end-to-end with correct and malformed MTHDS bundles: clean content lints with zero diagnostics and formats to itself (idempotently), malformed content comes back as a 200 verdict (`diagnostics[]` on lint/format with the content echoed unchanged, `is_valid: false` + `validation_errors[]` on validate), and malformed formatter options surface as a 422 `ApiResponseError`. The distinct `.e2e.ts` suffix + `vitest.e2e.config.ts` keep them out of the default `vitest run`, so `make test` / CI never require a server; the suite fails fast with a clear message when the server is unreachable rather than skipping silently.

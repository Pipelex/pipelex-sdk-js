# Deferred (cross-repo) — expose the tools routes (`lint`, `format`) on the hosted origins

**Status: the crate half is DONE (prod, measured 2026-08-23); `lint` / `format` remain.** `resolve` and `codegen` are allowlisted and served on both `api.pipelex.com` (`pipelex-hosted@0.10.1`) and `api-dev.pipelex.com`, so the caveat has been dropped from `docs/crate-routes.md`, `src/client.ts`, and the JS starter's README / `.env.example` / docs. `lint` and `format` were never included in that change and still 403 on every hosted origin. Found while landing `resolve()` / `codegen()` in `@pipelex/sdk` (PR #24). Never a bug in this SDK — the client is correct and works against any `pipelex-api` runner.

## Current state — measured 2026-08-23 with a real key

| Method | Path | On a runner | `api-dev.pipelex.com` | `api.pipelex.com` (`0.10.1`) |
| --- | --- | --- | --- | --- |
| `resolve` | `POST /v1/resolve` | yes | **yes** ✅ | **yes** ✅ |
| `codegen` | `POST /v1/codegen` | yes | **yes** ✅ | **yes** ✅ |
| `lint` | `POST /v1/lint` | yes | **no** — 403 | **no** — 403 |
| `format` | `POST /v1/format` | yes | **no** — 403 | **no** — 403 |

The crate routes are not merely reachable — the whole contract survives the gateway and the platform proxy: the happy path across all three codegen targets, `resolve`/`codegen` fingerprint agreement, and every non-2xx arm (`200` `is_valid: false` on an unresolvable closure, `501` on the reserved `method_ref`, `422` on a `pipe_ref` with the `types` kind). Re-measure with a key: unauthenticated, every path answers `401` whether allowlisted or not, so a keyless probe cannot distinguish the two states.

**What is left is `lint` / `format`, and it is not urgent.** They sit where `resolve` / `codegen` sat on 2026-08-03 — correct in the SDK, refused by the gateway — but nothing is blocked, because linting and formatting `.mthds` are toolchain capabilities rather than hosted ones: `plxt` carries both, and this SDK runs them offline through `@pipelex/tools-wasm` with no credentials, with `client.lint` / `client.format` as the documented fallback against a runner. The cost of leaving it is a bare 403 for the next consumer who reaches for the hosted route, which the comment on those two methods now explains.

## The gap (as originally found)

`DEFAULT_API_BASE_URL` is `https://api.pipelex.com` (`src/client.ts`), so a consumer who constructs `new PipelexApiClient({ apiKey })` with no `baseUrl` still cannot reach any of the four.

Calling an unexposed one gets a bare `403` `ApiResponseError` that says nothing about the route being unexposed.

**Dev was not a workaround — and for `lint` / `format` it still isn't.** The first instinct on hitting this was to point `PIPELEX_BASE_URL` at `https://api-dev.pipelex.com`; that failed identically, because dev and prod shared the allowlist. That has since diverged **for the crate routes only**: dev was allowlisted on 2026-08-13 and prod was not. For `lint` / `format` the original finding stands unchanged on both origins. The table below is therefore historical for `resolve()` / `codegen()` — those two pass on dev today, as the current-state table above records. Measured 2026-08-03 against `api-dev.pipelex.com` (`pipelex-hosted@0.2.6rc7`) through the SDK, same key, same run:

| Call | Result |
| --- | --- |
| `version()` | OK |
| `validate()` | OK — `is_valid: true` |
| `buildInputs()` | OK — `is_valid: true` |
| `resolve()` | `ApiResponseError` **403** `"Forbidden"` |
| `codegen()` | `ApiResponseError` **403** `"Forbidden"` |

The refusal is the gateway's, not the app's: `content-type: application/json` with a bare `{"message":"Forbidden"}` and no `request_id`, where an app-level rejection on the same origin returns `application/problem+json` carrying `instance`, `request_id`, `error_type` and `error_domain`. So the request is dying at the authorizer, before routing — which is what pins the cause to the allowlist rather than to the platform proxy or a stale runner image.

## Why — two independent gates, both enumerate routes explicitly

1. **The gateway authorizer's API-key allowlist.** `pipelex-api-infra/src/pipelex_lambdas/authorizer/utils.py` → `_API_KEY_ALLOWED_PREFIXES` lists `/v1/validate`, `/v1/models`, `/v1/build`, `/v1/upload`, `/v1/resolve-storage-url`, … and neither `/v1/resolve` nor `/v1/codegen`. The match is `path == prefix or path.startswith(prefix + "/")`, so `/v1/resolve` does **not** ride in on `/v1/resolve-storage-url`. The per-route listing is deliberate (the comment explains it keeps the JWT-only key routes out of API-key reach), so the fix is to add entries, never to broaden to a bare `/v1`.
2. **The platform's tooling proxy.** `pipelex-platform/.../routers/v1/tooling_proxy.py` declares `/validate`, `/models`, `/build/inputs`, `/build/output`, `/build/runner`, `/build/concept`, `/build/pipe-spec` — and nothing else. The greedy `ANY /v1/{proxy+}` route in `pipelex-api-infra/infra/api/apigateway_http.tf` forwards unmatched `/v1/*` to the platform, so an unlisted path dies there.

## What the fix looks like

Two repos, one change each, shipped together:

- `pipelex-server/infra` (formerly `pipelex-api-infra`) — add `/v1/lint` and `/v1/format` to `_API_KEY_ALLOWED_PREFIXES`; `/v1/resolve` and `/v1/codegen` are already there.
- `pipelex-server/platform` (formerly `pipelex-platform`) — add the matching `_proxy` handlers in `tooling_proxy.py`, alongside the existing `build/*` ones.

Then drop the `lint` / `format` caveat from `src/client.ts`'s tools-extensions section header and `docs/crate-routes.md`. The crate half of that sweep is already done.

**Verify the deployed runner image too, before declaring it fixed.** The 403 is raised at the authorizer, so it masks whatever lies behind it: allowlisting the paths could still surface a `404` if the ECS runner image predates the routes. Check the `pipelex-api` version pinned by `pipelex-api-hosted` for the target env against the release that added `/v1/resolve` + `/v1/codegen`, and confirm with a real call per environment (dev first) rather than assuming the allowlist change is sufficient.

## Why it is not in the SDK's PR

Nothing about it is a client-side change: the SDK cannot make a route reachable. The honest in-scope move was to document the gap where a consumer will hit it, which PR #24 does.

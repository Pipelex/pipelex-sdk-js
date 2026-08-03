# Deferred (cross-repo) — expose the crate + tools routes on `api.pipelex.com`

**Status:** open. Found while landing `resolve()` / `codegen()` in `@pipelex/sdk` (PR #24). Not a bug in this SDK — the client is correct and works against any `pipelex-api` runner. The gap is that the hosted surface does not route these paths, so the SDK's own default base URL cannot reach them.

## The gap

`DEFAULT_API_BASE_URL` is `https://api.pipelex.com` (`src/client.ts`). On that origin, four SDK methods are unreachable today:

| Method | Path | Reachable on a runner | Reachable on `api.pipelex.com` |
| --- | --- | --- | --- |
| `resolve` | `POST /v1/resolve` | yes | **no** |
| `codegen` | `POST /v1/codegen` | yes | **no** |
| `lint` | `POST /v1/lint` | yes | **no** (pre-existing) |
| `format` | `POST /v1/format` | yes | **no** (pre-existing) |

A consumer that constructs `new PipelexApiClient({ apiKey })` with no `baseUrl` and calls any of them gets a bare `403` `ApiResponseError` that says nothing about the route being unexposed.

## Why — two independent gates, both enumerate routes explicitly

1. **The gateway authorizer's API-key allowlist.** `pipelex-api-infra/src/pipelex_lambdas/authorizer/utils.py` → `_API_KEY_ALLOWED_PREFIXES` lists `/v1/validate`, `/v1/models`, `/v1/build`, `/v1/upload`, `/v1/resolve-storage-url`, … and neither `/v1/resolve` nor `/v1/codegen`. The match is `path == prefix or path.startswith(prefix + "/")`, so `/v1/resolve` does **not** ride in on `/v1/resolve-storage-url`. The per-route listing is deliberate (the comment explains it keeps the JWT-only key routes out of API-key reach), so the fix is to add entries, never to broaden to a bare `/v1`.
2. **The platform's tooling proxy.** `pipelex-platform/.../routers/v1/tooling_proxy.py` declares `/validate`, `/models`, `/build/inputs`, `/build/output`, `/build/runner`, `/build/concept`, `/build/pipe-spec` — and nothing else. The greedy `ANY /v1/{proxy+}` route in `pipelex-api-infra/infra/api/apigateway_http.tf` forwards unmatched `/v1/*` to the platform, so an unlisted path dies there.

## What the fix looks like

Two repos, one change each, shipped together:

- `pipelex-api-infra` — add `/v1/resolve`, `/v1/codegen`, `/v1/lint`, `/v1/format` to `_API_KEY_ALLOWED_PREFIXES`.
- `pipelex-platform` — add the matching `_proxy` handlers in `tooling_proxy.py`, alongside the existing `build/*` ones.

Then drop the caveat from `src/client.ts`'s crate-extensions section header, `docs/crate-routes.md`, and the `v0.10.0` CHANGELOG entry.

**Do all four routes at once.** `lint` / `format` have carried this gap since they landed; fixing only the two new ones would leave the same trap set for the next consumer.

## Why it is not in the SDK's PR

Nothing about it is a client-side change: the SDK cannot make a route reachable. The honest in-scope move was to document the gap where a consumer will hit it, which PR #24 does.

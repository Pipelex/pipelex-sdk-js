# Resume note — crate routes (`resolve` / `codegen`) once they ship to the hosted API

**Written:** 2026-08-03. **Repo:** `pipelex-sdk-js` (`@pipelex/sdk`). **Branch:** `feature/Codegen` → `dev`. **PR:** [#24](https://github.com/Pipelex/pipelex-sdk-js/pull/24), OPEN and mergeable.

## TL;DR

The SDK work is **done and verified** — `resolve()` and `codegen()` are implemented, tested against a live `pipelex-api`, documented, and reviewed clean by three bots plus a pre-landing review. PR #24 is merge-ready; it was deliberately not merged.

The one open thread is **not in this repo**: hosted exposure, a two-repo infra change (`pipelex-api-infra` + `pipelex-platform`) tracked in [`hosted-exposure-crate-and-tools-routes.md`](./hosted-exposure-crate-and-tools-routes.md).

**As of 2026-08-13 that thread is half-closed.** `api-dev.pipelex.com` (`pipelex-hosted@0.2.8`) now serves `resolve` and `codegen` with the full contract intact; `api.pipelex.com` is still on `0.2.6` and still 403s; and `lint` / `format` were left out of the allowlist change entirely, so they 403 on both. The caveats have been reworded to match — see the 2026-08-13 update below. Nothing about the client code needed to change, and still doesn't.

---

## Where we stand

| Item | State |
| --- | --- |
| `resolve()` / `codegen()` on `PipelexApiClient` | Implemented |
| Wire models + barrel exports | Implemented |
| Unit tests (`tests/crate-routes.test.ts`) | Passing |
| E2E tests (`tests/e2e/crate.e2e.ts`) | Passing against a **local** runner |
| Docs (`docs/crate-routes.md` + 3 updated) | Written |
| `CHANGELOG.md` `v0.10.0` entry | Written |
| CI (Quality Checks, gate-dev) | Green |
| Greptile / cubic / Codex | All pass, zero unresolved threads |
| PR #24 | **Open, mergeable, not merged** |
| Reachable on hosted | **dev YES** (`0.2.8`, contract verified 2026-08-13) · **prod no** (`0.2.6`, 403) · `lint`/`format` 403 on both |

`CLAAssistant` shows as failing. Ignore it: it fails identically on the pre-existing PR #18 with `There is at least one repository that does not exist or is not accessible to the parent installation` — a GitHub App installation fault in the repo, unrelated to this change. It is why `mergeStateStatus` reads `UNSTABLE` rather than `CLEAN`.

### Commits on the branch

```
ef9d540  Correct the hosted-exposure caveat: dev is affected too, and is not a workaround
7306c4f  Record the PR #24 review outcomes in the plan
278309a  Record why the static extension routes take no transport options
ed2d451  Document the hosted-exposure gap, correct the fingerprint claim, cover every codegen target
6d599cd  Mark the explicit-envelope handoff doc archived, and fix its wip links
b40be9c  Add resolve() and codegen() to PipelexApiClient — the crate routes
904e179  Fix `prepareInputs` to accept explicit {concept, content} envelope inputs   ← pre-existing, docs-only, rode along
```

---

## The blocker, precisely

`api.pipelex.com` and `api-dev.pipelex.com` gate `/v1/*` twice, and **both gates enumerate routes explicitly**:

1. **The gateway authorizer's API-key allowlist** — `pipelex-api-infra/src/pipelex_lambdas/authorizer/utils.py` → `_API_KEY_ALLOWED_PREFIXES`. It lists `/v1/validate`, `/v1/models`, `/v1/build`, `/v1/upload`, `/v1/resolve-storage-url`, … and neither `/v1/resolve` nor `/v1/codegen`. The match is `path == prefix or path.startswith(prefix + "/")`, so **`/v1/resolve` does not ride in on `/v1/resolve-storage-url`**. The per-route listing is deliberate — the code comment explains it keeps the JWT-only key routes out of API-key reach — so the fix is to add entries, never to broaden to a bare `/v1`.
2. **The platform's tooling proxy** — `pipelex-platform/.../routers/v1/tooling_proxy.py` declares `/validate`, `/models`, `/build/inputs`, `/build/output`, `/build/runner`, `/build/concept`, `/build/pipe-spec` and nothing else. The greedy `ANY /v1/{proxy+}` route in `pipelex-api-infra/infra/api/apigateway_http.tf` forwards unmatched `/v1/*` there, so an unlisted path dies at the proxy.

`lint` and `format` have carried the identical gap since they landed. **Fix all four at once** — fixing only the two new ones leaves the same trap set for the next consumer.

### Evidence (measured 2026-08-03, `api-dev.pipelex.com`, `pipelex-hosted@0.2.6rc7`)

Same API key, same origin, same run, through the SDK:

| Call | Result |
| --- | --- |
| `version()` | OK — `pipelex-hosted@0.2.6rc7` |
| `validate()` | OK — `is_valid: true` |
| `buildInputs()` | OK — `is_valid: true` |
| `resolve()` | `ApiResponseError` **403** `"Forbidden"` |
| `codegen()` | `ApiResponseError` **403** `"Forbidden"` |

**The refusal is the gateway's, not the app's** — and that distinction is the diagnostic:

- `/v1/resolve` → `content-type: application/json`, body `{"message":"Forbidden"}`, **no** `request_id`.
- `/v1/build/inputs` on the same origin → `content-type: application/problem+json` carrying `instance`, `request_id`, `error_type`, `error_domain`.

So the request dies at the authorizer *before routing*. That pins the current blocker to the allowlist and rules out the platform proxy and a stale runner image as the *first* thing in the way — but see the warning below, because the 403 masks whatever is behind it.

> **Dev was never a workaround.** Dev and prod share the allowlist. The instinct on hitting the prod 403 is to point `PIPELEX_BASE_URL` at dev; that fails identically. This is called out in the code comment, the doc, and the changelog, because the original wording named only `api.pipelex.com` and invited exactly that inference.

### Update — 2026-08-13: dev SHIPPED, prod still blocked, `lint`/`format` left behind

The allowlist change landed on dev. Measured through the SDK, same key, same run:

| Call | `api-dev.pipelex.com` (`0.2.8`) | `api.pipelex.com` (`0.2.6`) |
| --- | --- | --- |
| `version()`, `validate()` | OK | OK |
| `resolve()` | **OK** `is_valid: true` | 403 |
| `codegen()` — all three targets | **OK**, `crate_fingerprint` agrees with `resolve` | 403 |
| `lint()`, `format()` | **403** | **403** |

**The contract holds on hosted, not just the happy path.** Every non-2xx arm survives the gateway and the platform proxy intact: an unresolvable closure returns a `200` `is_valid: false` with `validation_errors[]` (both routes), the reserved `method_ref` returns `501`, and a `pipe_ref` on the `types` kind returns `422`. That was the open risk in pointing a consumer at hosted — a proxy that mangled non-2xx bodies would have broken the verdict discipline — and it is now measured, not assumed.

**Prod needs only the deploy.** It is still on `0.2.6`; dev is on `0.2.8`. No further code change is implied.

**`lint` / `format` were not included in the change, and now sit in exactly the trap this note warned about** ("Fix all four at once — fixing only the two new ones leaves the same trap set for the next consumer"). They 403 on both origins. The tools-extensions section of `src/client.ts` had never carried a caveat at all — that omission is now fixed as part of this update.

**Caveats were reworded, not deleted.** The checklist below assumed full exposure and said "delete"; partial exposure makes that wrong in the opposite direction — the old wording ("not reachable on any hosted environment, dev included") would now steer a developer away from the one origin that works. Updated in `src/client.ts` (both sections), `docs/crate-routes.md`, `CHANGELOG.md`, `TODOS.md` and `hosted-exposure-crate-and-tools-routes.md`. **When prod ships, the remaining edit is small: drop the prod row from each, and keep the `lint`/`format` caveat until those are allowlisted too.**

**Checklist step 3 is not executable as written.** `PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com make test-e2e` fails before any test runs: the suites' `beforeAll` preflight calls `client.health()` → `GET /health`, which is a bare-runner endpoint the hosted gateway does not serve (`404`), so the suite aborts with "No pipelex-api server reachable". Pointing the e2e suite at hosted first requires changing that preflight to a route hosted actually serves (`version()`). Not done here — it is a test-infrastructure change, not part of this note's scope.

### Re-verification — 2026-08-11: still blocked

Re-ran the step-1 probe below against dev **and** prod. Unchanged: `version()` and `validate()` succeed on both origins, while `resolve()` and all three `codegen()` targets answer `403 Forbidden` with **no `request_id`** — the gateway-authorizer signature, not an application refusal. The hosted stack has moved on (`pipelex-hosted@0.2.6`, released, vs `0.2.6rc7` in August's measurement) **without** the allowlist being touched, which is the point: shipping hosted releases does not drift this gap shut on its own. It needs the deliberate `pipelex-api-infra` + `pipelex-platform` change.

> **A local runner serving the routes is not the unblock, and is easy to misread as one.** Every caveat already says "served by any `pipelex-api` runner" — local support has been the baseline since the branch landed, so a fresh local runner answering `resolve` / `codegen` changes nothing about hosted reachability. The trigger for the checklist below is a **200 from a `*.pipelex.com` origin**, nothing less. Verified green on `http://localhost:8092` (`pipelex-api@0.11.1`) the same day, including all three codegen targets and the resolve↔codegen fingerprint agreement — that is the expected state, not progress.

**Unrelated drift spotted while probing, worth its own look:** the local runner reports `protocol_version` **0.6.0** while both hosted environments report **0.1.0**. Not a crate-routes issue and not chased here.

---

## Resume checklist — when the endpoints ship to hosted

### 1. Verify with a real call, per environment (dev first)

Do not infer success from the Terraform diff. `.env` in this repo already holds `PIPELEX_BASE_URL` / `PIPELEX_API_KEY` (globally gitignored). Save this as a scratch file and run `node <file>`:

```js
import { PipelexApiClient, ApiResponseError } from "./dist/index.js";

const client = new PipelexApiClient({
  baseUrl: process.env.PIPELEX_BASE_URL,
  apiKey: process.env.PIPELEX_API_KEY,
});

const BUNDLE = `domain = "smoke"
main_pipe = "echo"

[concept.Customer]
description = "A customer"

[concept.Customer.structure]
name = { type = "text", description = "Customer name" }

[pipe.echo]
type = "PipeLLM"
description = "Echo"
inputs = { text = "Text" }
output = "Customer"
prompt = "@text"
`;
const files = [{ content: BUNDLE, source: "smoke.mthds" }];

for (const [label, fn] of [
  ["version()", () => client.version()],
  ["validate()", () => client.validate([BUNDLE])],
  ["resolve()", () => client.resolve({ files })],
  ["codegen()", () => client.codegen({ files, kind: "types", target: "ts-zod" })],
]) {
  try {
    const r = await fn();
    console.log(`${label.padEnd(14)} OK    is_valid=${r.is_valid}`);
  } catch (err) {
    const detail = err instanceof ApiResponseError ? `status=${err.status} ${err.serverMessage}` : String(err);
    console.log(`${label.padEnd(14)} THREW ${detail}`);
  }
}
```

Run it with `set -a; . ./.env; set +a` first, and after `make build` so `dist/` is current.

**Watch for a `404` rather than a `200`.** The 403 masks everything behind it: allowlisting the paths could simply surface a 404 if the ECS runner image predates the routes. Check the `pipelex-api` version pinned by `pipelex-api-hosted` for that environment against the release that added `/v1/resolve` + `/v1/codegen`.

### 2. Drop the caveat — it appears in exactly four places

| File | What to remove |
| --- | --- |
| `src/client.ts` | The `NOT YET REACHABLE ON ANY HOSTED ENVIRONMENT` block in the `── Crate extensions ──` section header |
| `docs/crate-routes.md` | The two-paragraph blockquote under the intro |
| `CHANGELOG.md` | The `**Note:**` sentence inside the `v0.10.0` Added entry |
| `wip/hosted-exposure-crate-and-tools-routes.md` | The whole note — delete it, or mark it shipped |

Also remove the follow-up line from `TODOS.md` → "Out of scope / follow-ups".

Keep the caveat for `lint` / `format` if only the crate routes were exposed.

### 3. Optionally point the e2e suite at hosted

`tests/e2e/crate.e2e.ts` defaults to `http://localhost:8081` via `PIPELEX_E2E_BASE_URL`. Once hosted serves the routes, `PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com PIPELEX_API_KEY=… make test-e2e` exercises the same contract against the hosted stack. Do not add it to CI — CI must never require a live server.

---

## What was built (for someone picking this up cold)

Two Pipelex API extension routes (not `x-mthds-protocol`), sharing the build routes' closure envelope and verdict discipline.

- **`resolve(request)`** → `POST /v1/resolve`. Returns the normalized library crate — the MTHDS standard's Library Crate Format. Runs no dry-run sweep.
- **`codegen(request)`** → `POST /v1/codegen`. Projects that crate through two explicit axes, `kind` (`types`) × `target` (`ts-zod` | `python-pydantic` | `python-structures`), returning stamped artifacts plus their `codegen.lock`.

**Verdict discipline (the thing consumers get wrong):** a produced verdict is a **200** discriminated on `is_valid`. An unresolvable closure comes back as `is_valid: false` with `validation_errors[]` — *not* a thrown error. Only a no-verdict condition throws `ApiResponseError`: request-shape `422` (including a `pipe_ref` on the concept-set-wide `types` kind), the reserved `method_ref` `501`, auth, `5xx`. **Branch on `is_valid`, never on the transport.**

**The codegen trust chain:** write every artifact at its `path` and the `lock` content as `lock_filename`, both verbatim, and the tree is byte-identical to a local `pipelex codegen types` run — so the offline `pipelex codegen check` passes on it. Reformatting an artifact or re-serializing the lock breaks the chain. There is deliberately no server-side check route. The SDK stays transport-only and does not write files.

**Fingerprint semantics — easy to get wrong, and I did at first.** The fingerprint is a property of the *logical* crate, not of any encoding: the server hashes `{concepts, pipes, domains}` with each object's provenance `source` stripped, excluding `source_map`, `mthds_version` and `fingerprint` itself. It **cannot** be recomputed by hashing the returned crate object. Nor is the response the same *bytes* as `pipelex resolve --format json` — the CLI pretty-prints (`indent=2`), the route answers compact JSON. Compare `fingerprint` values; never serialized bytes.

### Decisions taken (with reasons, so they aren't re-litigated)

- **`CrateRequestBase`, with `BuildRequestBase` extending it.** The plan leaned toward leaving `BuildRequestBase` untouched, but the inheritance is not forced — it is exactly the server's own hierarchy (`MthdsPipeRequest(MthdsFilesRequest)`). Structurally identical for consumers; one place documents the selector.
- **The `files` XOR `method_ref` invariant stays server-side**, not a discriminated union. The union would force the overwhelmingly common `{ files }` call site to pick a branch for no gain, and the server rejects both illegal shapes with a typed `ApiResponseError` either way.
- **No `method_id` sugar** on these methods (unlike `buildInputs`). The workaround is one line and is exactly what the sugar would do internally: `resolve({ files: await client.getMethodClosure(id) })`. See [`crate-routes-method-id-sugar.md`](./crate-routes-method-id-sugar.md) for the trigger that would change the answer.
- **No `timeoutMs` / `signal`** on either method. Raised twice by independent reviewers and dismissed twice, so the reasoning now lives on `requestExtension`'s TSDoc — the shared chokepoint, so it covers the whole static family rather than whichever route is newest. Reasons: the transport-options split tracks the **dry-run sweep** (only `buildRunner` sweeps), input is bounded server-side (16 files × 1 MiB, no inference), and on the hosted path an override is inert because the gateway caps responses at ~30s.
- **One PR, not a stack.** Splitting at the checkpoint boundary would have put the new public surface in a PR with no tests and stale docs.
- **Version files deliberately not bumped.** `CHANGELOG.md` carries a `v0.10.0` heading while `package.json` / `SDK_VERSION` stay `0.9.0`. That is this repo's convention: `.claude/skills/release/SKILL.md` bumps on a `release/vX.Y.Z` branch and explicitly handles a pre-existing heading; `d32fd9c` is direct precedent ("Version bump deferred to /release"). Bumping `SDK_VERSION` alone would fail `tests/index.test.ts`, which asserts `SDK_VERSION === pkg.version`. Both Codex and cubic flagged this; both were answered and resolved.

### Still deferred (each has its own wip note)

| Item | Note |
| --- | --- |
| Hosted exposure of `resolve` / `codegen` / `lint` / `format` | [`hosted-exposure-crate-and-tools-routes.md`](./hosted-exposure-crate-and-tools-routes.md) |
| `ValidationErrorItem` missing `missing_pipe_code` + `suggested_fix` | [`validation-error-item-drift.md`](./validation-error-item-drift.md) |
| By-id (`method_id`) sugar | [`crate-routes-method-id-sugar.md`](./crate-routes-method-id-sugar.md) |
| `mthds-js/src/agent/commands/api-commands.ts:474` still hard-errors "the Pipelex API has no codegen routes yet" — stale | `TODOS.md` |
| `pipelex-sdk-python` parity (`resolve` / `codegen`) | `TODOS.md` |
| A helper that writes artifacts + lock to disk | `TODOS.md` — deliberately not done; the SDK stays transport-only |

---

## Commands

```bash
make check                      # lint + format + typecheck + build + depcruise
make test                       # unit suites (mock the fetch boundary)
make test-e2e                   # LIVE server, PIPELEX_E2E_BASE_URL (default http://localhost:8081)

# Start a local runner for the e2e suite:
cd ../pipelex-api && .venv/bin/uvicorn api.main:app --port 8081
```

The e2e suite is what pins the `kind` / `target` vocabulary: `CodegenTarget` is a hand-written mirror of a Python `StrEnum` in another repo, so a member the server stops serving is invisible to the type-checker *and* to every mocked test. It covers all three targets exhaustively, and cross-checks that `codegen`'s `crate_fingerprint` equals the `fingerprint` `resolve` returns for the same closure.

## Key file map

| Path | What |
| --- | --- |
| `src/client.ts` | `resolve()` / `codegen()` in the `── Crate extensions ──` section; the transport-options policy note on `requestExtension` |
| `src/models.ts` | `CrateRequestBase`, `Resolve*`, `Codegen*`; shared `CrateInvalidReport` / `GeneratedArtifact` |
| `src/index.ts` | Barrel exports |
| `tests/crate-routes.test.ts` | Unit — envelope serialization, both verdict arms, what throws |
| `tests/e2e/crate.e2e.ts` | E2E — live crate, all three targets, fingerprint agreement, 422/501 |
| `docs/crate-routes.md` | The consumer-facing story |
| `TODOS.md` | The executed plan, decisions log, review outcomes |

Server side, for checking wire shapes: `pipelex-api/api/routes/pipelex/{resolve,codegen,crate_ops}.py`, `pipelex-api/api/schemas/models.py`, `pipelex/pipelex/codegen/emitters/target.py`.

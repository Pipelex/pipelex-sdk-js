# Plan — add `resolve()` and `codegen()` to `PipelexApiClient`

Bring the SDK up to date with the two crate-family routes `pipelex-api` now serves: `POST /v1/resolve` (the normalized library crate) and `POST /v1/codegen` (stamped typed artifacts + `codegen.lock`). Both are Pipelex API extensions (not `x-mthds-protocol`), share the closure-selector envelope (`files[]` XOR `method_ref`), and follow the `/validate` discipline: a produced verdict is a **200** discriminated on `is_valid`; the invalid arm is the existing `CrateInvalidReport`; non-2xx is reserved for no-verdict conditions (request-shape 422, `method_ref` 501, auth, 5xx).

Server references: `pipelex-api/api/routes/pipelex/resolve.py`, `pipelex-api/api/routes/pipelex/codegen.py`, `pipelex-api/api/routes/pipelex/crate_ops.py`, `pipelex-api/api/schemas/models.py` (`MthdsFilesRequest`). Spec: `../docs/specs/command-surface-map.md` §codegen family, `../docs/specs/pipelex-codegen.md`.

## Phase 1 — wire models (`src/models.ts`) — DONE

- [x] Shared `MthdsFilesRequest`-shaped envelope for the crate routes → `CrateRequestBase` (`{ files?: MthdsFileItem[]; method_ref?: string }`), with `BuildRequestBase extends CrateRequestBase` adding only `pipe_ref` (see decisions log).
- [x] `ResolveRequest` = the crate envelope (alias of `CrateRequestBase`; no `method_id` pin — by-id sugar deferred).
- [x] `ResolveValidReport`: `{ is_valid: true; crate: Record<string, unknown>; message: string }`, documenting the canonical JSON encoding and the in-payload `fingerprint` / `mthds_version`.
- [x] `ResolveResponse = ResolveValidReport | CrateInvalidReport`; `CrateInvalidReport`'s doc comment now names all three route families.
- [x] `CodegenKind` = `"types"`.
- [x] `CodegenTarget` = `"ts-zod" | "python-pydantic" | "python-structures"` — verified against `pipelex/pipelex/codegen/emitters/target.py`'s `StrEnum` values.
- [x] `CodegenRequest` = crate envelope + `{ kind; target; pipe_ref? }`, documenting the `types` + `pipe_ref` 422.
- [x] `CodegenValidReport` with the trust chain documented; reuses `GeneratedArtifact` (doc comment now names both consumers).
- [x] `CodegenResponse = CodegenValidReport | CrateInvalidReport`.

## Phase 2 — client methods (`src/client.ts`) — DONE

- [x] `async resolve(request): Promise<ResolveResponse>` — `POST /v1/resolve` through the shared `requestExtension` pipeline.
- [x] `async codegen(request): Promise<CodegenResponse>` — `POST /v1/codegen`, same discipline.
- [x] By-id sugar **deferred** — see the decisions log and [`wip/crate-routes-method-id-sugar.md`](./wip/crate-routes-method-id-sugar.md).
- [x] Methods sit in a `── Crate extensions (Pipelex API — /v1/resolve, /v1/codegen) ──` section above the build section, with TSDoc covering the 200-verdict discipline, the `method_ref` 501, and the `getMethodClosure` expansion for stored methods.

**Checkpoint 1** — ✅ `make check` + `make test` green; decisions recorded below.

## Phase 3 — barrel + boundaries — DONE

- [x] Export the new request/response types (and nothing internal) from `src/index.ts`.
- [x] `make check` passes in full: lint, format, typecheck, build, depcruise (no new imports crossing the `mthds/protocol`-only boundary — these routes are Pipelex extensions, so all their types live here, not in `mthds`).

## Phase 4 — tests — DONE

- [x] New `tests/crate-routes.test.ts`, mocking the fetch boundary like the existing suites:
  - [x] `resolve` valid arm: returns the crate object untouched (nested payload + in-crate `fingerprint`).
  - [x] `codegen` valid arm: artifacts + `lock` + `lock_filename` + `crate_fingerprint` + `engine_version` surface verbatim.
  - [x] Both routes: `is_valid: false` returns the `CrateInvalidReport` — not a thrown error.
  - [x] Both routes: non-2xx (422 problem+json, 501 `method_ref`) throws `ApiResponseError`, with `serverMessage` pinned on the 422.
  - [x] Request serialization: `codegen` sends `kind`/`target` and omits `pipe_ref` **entirely** when unset; a `method_ref`-only envelope carries no `files` key.
- [x] E2E `tests/e2e/crate.e2e.ts` against a live `pipelex-api`: crate + fingerprint, ts-zod artifacts + lock, `resolve`/`codegen` fingerprint agreement, invalid arm on a broken bundle, the `pipe_ref`-on-`types` 422, the `method_ref` 501.

## Phase 5 — docs + changelog — DONE

- [x] New [`docs/crate-routes.md`](./docs/crate-routes.md): the shared envelope, the verdict discipline, the codegen trust chain, `ts-zod` for TS consumers, the `pipe_ref`-is-rejected-not-ignored rule, and the `getMethodClosure` line for stored methods.
- [x] `docs/architecture.md` — surface list, the `models.ts` module description, and the E2E paragraph.
- [x] `CHANGELOG.md` — `[Unreleased]` Added (`resolve()` / `codegen()` + the new exported types) and Changed (`BuildRequestBase extends CrateRequestBase`).
- [x] `README.md` status line now names the crate routes.

**Checkpoint 2** — ✅ `make check` + `make test` green (all unit suites), and `make test-e2e` green against a live local `pipelex-api` — all e2e tests pass, including the new crate suite. The live run is what pins the `kind`/`target` vocabulary against the server's Python `StrEnum`.

## Review outcomes (PR [#24](https://github.com/Pipelex/pipelex-sdk-js/pull/24))

CI green (Quality Checks, gate-dev); Greptile 5/5 and cubic pass on HEAD; no unresolved threads. (`CLAAssistant` fails, but it fails identically on the pre-existing PR #18 — a GitHub App installation fault in the repo, not this change.)

Findings that landed as fixes:

- The `requestExtension` TSDoc still enumerated only tools + build routes — widened, with the `CrateInvalidReport` no-verdict list corrected at the same time (it named an unknown `pipe_ref`, which `/v1/resolve` has no concept of).
- **The crate routes are not reachable on `api.pipelex.com`** — verified against the gateway authorizer's allowlist and the platform tooling proxy. Documented at the call sites; cross-repo fix tracked in `wip/`.
- **The fingerprint documentation was wrong** — it is a property of the logical crate (hashes `{concepts, pipes, domains}` with `source` stripped), and the route's compact JSON is not the CLI's pretty-printed bytes. Corrected in the TSDoc and the doc.
- **`python-structures` was declared but never called live** — the e2e suite now covers all three `CodegenTarget` members exhaustively.
- A stale `wip/` handoff doc invited coding from a superset `{concept, content}` predicate the shipped `isExplicitEnvelope` deliberately rejects — archived and annotated.

Findings dismissed, with the reasoning recorded so they do not recur:

- **Bump `package.json` / `SDK_VERSION` alongside the changelog** (Codex + cubic) — the `/release` skill owns the bump on a `release/vX.Y.Z` branch, `d32fd9c` is direct precedent, publishing only triggers on `main`, and the change would fail `tests/index.test.ts`.
- **Add `timeoutMs` / `signal` to `resolve` / `codegen`** (raised twice, independently) — the transport-options split tracks the dry-run sweep, not the age of the route; input is bounded server-side; the hosted gateway caps responses at ~30s so an override would be inert. Now recorded as a policy note on `requestExtension` (the shared chokepoint, so it covers the whole static family) with pointers from the crate-extensions header and `buildRunner`'s TSDoc.

## Out of scope / follow-ups (tracked, not done here)

- [ ] `mthds-js/src/agent/commands/api-commands.ts:474` still hard-errors "the Pipelex API has no codegen routes yet" — stale now; fix belongs in `mthds-js`, in its own change.
- [ ] `pipelex-sdk-python` parity (`resolve`/`codegen` on `PipelexAPIClient`) — separate repo, separate change.
- [ ] Consider a convenience helper that writes `artifacts` + lock to disk — deliberately **not** in this change; the SDK stays transport-only for now.
- [ ] By-id (`method_id`) sugar on `resolve`/`codegen` — deferred, see [`wip/crate-routes-method-id-sugar.md`](./wip/crate-routes-method-id-sugar.md).
- [ ] **Expose `/v1/resolve`, `/v1/codegen` (and the pre-existing `/v1/lint`, `/v1/format`) on `api.pipelex.com`** — cross-repo (`pipelex-api-infra` allowlist + `pipelex-platform` tooling proxy). **Partially shipped 2026-08-13, re-verified 2026-08-19:** the two crate routes work on `api-dev.pipelex.com` (now `pipelex-hosted@0.9.0`, first seen on `0.2.8` — the exposure survived a redeploy), verdict discipline intact. Still open: prod (on `0.2.6`, awaiting the deploy — no further code change needed) and **`lint` / `format`, which were left out of the allowlist change and still 403 on both origins** — exactly the "fix all four at once" trap the note warned about. Tracked in [`wip/hosted-exposure-crate-and-tools-routes.md`](./wip/hosted-exposure-crate-and-tools-routes.md).
- [ ] **`ValidationErrorItem` is missing `missing_pipe_code` + `suggested_fix`** — pre-existing drift on the shared invalid arm, so it now touches these routes too. Deferred because closing it properly means porting the `SuggestedFix`/`FixOp`/`FixSafety` family; see [`wip/validation-error-item-drift.md`](./wip/validation-error-item-drift.md).

## Decisions log

**Checkpoint 1** (Phases 1–3):

- **`CrateRequestBase` vs reuse of `BuildRequestBase`** → new `CrateRequestBase`, and `BuildRequestBase` now **extends** it rather than restating `files`/`method_ref`. The plan leaned toward leaving `BuildRequestBase` untouched to avoid forced inheritance, but the inheritance here is not forced: it is exactly the server's own hierarchy (`MthdsPipeRequest(MthdsFilesRequest)`), so the build envelope genuinely *is* the crate envelope plus `pipe_ref`. Structurally identical for consumers (TypeScript interfaces are structural), one place documents the selector, and the two families cannot drift on it.
- **XOR not modelled in the type system** — `CrateRequestBase` keeps both selectors optional rather than becoming a discriminated union. The union would force the overwhelmingly common `{ files }` call site to satisfy a branch for no gain, and the server rejects both illegal shapes (neither / both) with a request-shape 422 that already surfaces as a typed `ApiResponseError`.
- **By-id `method_id` sugar → deferred.** `buildInputs` has it because `prepareInputs` needs it internally; nothing in this change does. The workaround is a single line (`resolve({ files: await client.getMethodClosure(id) })`), documented in the `resolve` TSDoc, whereas the sugar costs a second param type per method, a runtime guard for JS callers, and its own tests. Revisit when a real consumer asks. Note written to `wip/crate-routes-method-id-sugar.md`.
- **Test/docs file placement** → `tests/crate-routes.test.ts` and `docs/crate-routes.md`, both new. `tests/build-routes.test.ts` is already large and pins a different envelope (`pipe_ref` defaulting); `docs/build-routes.md` is about the per-pipe projections, while the crate routes' story is the crate + the codegen trust chain. The shared pieces (`CrateInvalidReport`, verdict discipline) get cross-links rather than a copy.

# TODOS — `@pipelex/sdk` v0.6.0: methods-surface reconciliation + `method_id` closure resolution

Working plan for the `feature/Method-id` branch. Two complementary bodies of work land together in v0.6.0:

- **A. Closure resolution** (the headline, from [`wip/method-id-closure-resolution.md`](./wip/method-id-closure-resolution.md)): give the SDK a canonical parser that turns a stored method's polymorphic source into runnable file contents, plus a fetch-and-parse convenience, plus by-id (`method_id`) support on `prepareInputs`/`buildInputs`. This unblocks `pipelex-mcp`'s `mthds_prepare_inputs` tool and lets the MCP retire its parser mirror.
- **B. Drift reconciliation**: the SDK's methods surface has drifted from the platform's `/v1/methods` contract. Correct it in the same pass since we're already in this area.

A and B are orthogonal: A is a *client-side semantic layer* over `getMethod` (the platform has no route that returns a parsed closure); B is *transport/model fidelity* to routes that already exist. Neither subsumes the other.

---

## ▶ RESUME HERE — state as of Phase A complete (last session)

**Done: all of Phase A (A1 + A2 + A3).** Committed on `feature/Method-id` as `0dcdc54` ("feat: add method_id support for buildInputs and prepareInputs"). **Working tree is clean** — everything below, plus the checked boxes in this file, is in that commit. `make check` and `make test` were both green at commit time (the tree is unchanged since, so they still are). The commit also (re)tracks `TODOS.md` and `wip/method-id-closure-resolution.md`.

**Remaining: Phase B (drift reconciliation) and Phase C (docs/changelog/contract-check).** Start at Phase B below — it's independent of A. Then C.

**Concrete surface that landed in Phase A** (verify by reading, don't rebuild):
- `src/method-source.ts` — NEW. `methodSourceToContents(mthds: string): string[]` (verbatim port + `rawBundle`/`isFileEntry` helpers). Exported from the barrel.
- `src/errors.ts` — NEW `EmptyMethodSourceError extends InputPreparationError` (public readonly `methodId`). Exported from the barrel's errors block.
- `src/client.ts` — NEW `getMethodClosure(methodId): Promise<MthdsFileItem[]>` immediately after `getMethod`. NEW exported client param type `BuildInputsByMethodId` (defined after `MthdsFile`, exported from the barrel). `buildInputs` param widened to `BuildInputsRequest | BuildInputsByMethodId`; the by-id branch resolves via `getMethodClosure`, strips `method_id`, posts the normal `files`-form body. Imports added: `InputsTemplateFormat`, `MthdsFileItem`, `EmptyMethodSourceError`, `methodSourceToContents`.
- `src/prepare-inputs.ts` — `PrepareInputsRequest` is now a discriminated union `{files}|{method_id}` (mutually exclusive via `never` guards) over a shared `PrepareInputsBase`. `PrepareCapableClient` gained `getMethodClosure`. NEW private `resolveClosureFiles` helper resolves the closure at the top of `prepareInputs` (with a runtime `InputPreparationError` guard for the degenerate neither-given case).
- Tests: NEW `tests/method-source.test.ts`, NEW `tests/method-closure.test.ts`; extended `tests/prepare-inputs.test.ts` (fake client gained call-recording `getMethodClosure`; new by-id describe incl. a `@ts-expect-error` type-level test that `typecheck:test` enforces) and `tests/build-routes.test.ts` (by-id `buildInputs` posts resolved `files`, `method_id` never on the wire).

**Nuances a resumer should know:**
- **`method_id` never travels on the wire** — it's resolved to `files` client-side. `BuildInputsByMethodId` is a *client param type*, deliberately NOT part of the wire model `BuildInputsRequest`. Keep it that way. Do not confuse it with `BuildRequestBase.method_ref` (reserved registry ref, server 501s).
- **By-id `buildInputs` / `prepareInputs` make TWO fetch calls**: first `GET /v1/methods/{id}` (the `getMethod`), then the `build/inputs` POST. Any new test at the fetch boundary must mock both (`mockResolvedValueOnce` ×2) — see the by-id test in `tests/build-routes.test.ts`.
- **`MTHDSProtocol` is exactly `execute/start/validate/models/version`** — `buildInputs` is a client extension, so widening it broke no interface conformance. Confirmed against `node_modules/mthds/dist/protocol/protocol.d.ts`.

---

## Cold-start context (read this first in a new session)

**What the SDK is.** `@pipelex/sdk` (`PipelexApiClient`) is the TS client for the Pipelex hosted API. Flat `src/`. ESM-only, `tsc` build, Vitest, `make check` before commit. Depends one-way on `mthds/protocol` only. See `CLAUDE.md`.

**The platform side (source of truth for B).**
- Router: `../pipelex-platform/src/pipelex_platform/routers/v1/methods.py` — org-scoped method CRUD. **Has GET (list), GET/{id}, POST, PUT/{id}. NO DELETE — explicitly "by design"** (docstring: *"Do not reintroduce a `DELETE /methods/{id}` without an explicit product decision"*).
- Schemas: `../infra-python-tools/src/pipelex_shared/schemas/method.py` — `MethodSaveBody` (write body: `name`, `mthds`, `input_data`; `pipe_output` deliberately NOT accepted on save), `MethodPublic` (read base: adds `method_id`, `org_id`, `created_by_user_id`, `pipe_output`, `created_at`, `updated_at`), and the router's `MethodRead(MethodPublic)` which adds a **derived `description`** (parsed at read time from the bundle's top-level TOML `description` key via `services.method_description.extract_method_description` — NOT a stored column, read-side only).
- Reachability: the methods router is gated so a JWT caller needs `ff_playground` and an **API-key caller needs `ff_api_keys`** — so by-id resolution works with an API key (the catalog is org-scoped to the key's org; an unknown *or* foreign-org id is a 404).

**The parser to lift (source of truth for A).** `../pipelex-mcp/src/capabilities/method-source.ts` — a proven, tested `methodSourceToContents(mthds: string): string[]`. Its tests: `../pipelex-mcp/src/capabilities/method-source.test.ts`. Its closure-building consumer (for reference on provenance + empty-source handling): `../pipelex-mcp/src/capabilities/shared.ts` (`fetchMethodFiles`, ~line 508 — builds files as `{ content, uri: methodId }`, and on `contents.length === 0` returns a `no_source` error). The canonical Python original is `../pipelex-platform/src/pipelex_platform/routers/v1/execution.py` (`_method_source_to_contents` + the blank guard in `_resolve_method_contents`).

**Decisions taken (from the planning discussion, 2026-07-23):**
1. **`deleteMethod` → REMOVE.** It wraps a route the platform will never have. Breaking export change; note it.
2. **Read-model fields → ADD ALL THREE** (`org_id`, `created_by_user_id`, `description`) to `MethodData`. All additive. `description` is server-derived — the SDK only needs the field, no client parsing.
3. **`EmptyMethodSourceError` → extends `InputPreparationError`.** Lands in the preparation-failure family consumers already catch.

**Key SDK files.**
- `src/client.ts` — `PipelexApiClient`. Methods CRUD at ~`914` (`getMethod`), `908`–`931`. `buildInputs` build-route wrapper at ~`708`. Product requests go through `requestProduct(...)`; a non-2xx maps to `ApiResponseError` (branch on `.code`, e.g. `not_found`).
- `src/product-models.ts` — `MethodData` (~`27`), `MethodWriteInput` (~`40`).
- `src/prepare-inputs.ts` — `prepareInputs` fn + `PrepareInputsRequest` / `PrepareCapableClient`.
- `src/models.ts` — `MthdsFileItem = { content: string; source?: string }` (~`238`); `BuildInputsRequest extends BuildRequestBase` (~`261`); note `BuildRequestBase.method_ref?` is a **reserved, unrelated** wire field (registry ref; server 501s today) — do NOT conflate it with our client-side `method_id`.
- `src/errors.ts` — error hierarchy. `InputPreparationError extends PipelineRequestError`; upload subclasses extend `InputPreparationError`.
- `src/index.ts` — public barrel (must export new public symbols; `SDK_VERSION` const synced to `package.json`, enforced by `tests/index.test.ts`).
- `docs/input-preparation.md` — carries the "`method_id` resolution deferred" caveat to drop.
- `CHANGELOG.md` — newest entry at top; current top is `[v0.5.1]`.

**Version note.** Do NOT hand-bump `package.json` / `SDK_VERSION` mid-work (`tests/index.test.ts` asserts they match). The `/release` skill owns the version bump + CHANGELOG heading/date finalization. Write CHANGELOG prose now under a `## [v0.6.0]` heading; reconcile with `/release` at cut time.

---

## Phase A1 — Canonical parser: `methodSourceToContents`

- [x] Create `src/method-source.ts`. Port `methodSourceToContents` **verbatim** from `../pipelex-mcp/src/capabilities/method-source.ts` (incl. `rawBundle` + `isFileEntry` helpers). Keep the full doc comment that pins it to `execution.py` and records the one deliberate divergence (platform's falsy `if method.mthds` guard vs. the TS `.trim()`-to-"no source" — preserve the TS behavior).
- [x] Export `methodSourceToContents` from `src/index.ts`.
- [x] Create `tests/method-source.test.ts` — port the MCP's cases: raw source → one bundle; JSON file-array → each content; file-array with blanks → blanks dropped; all-blank array → `[]`; `"[]"` → `[]`; `""` / whitespace-only → `[]`; `null`/`undefined` (contract-violating) → `[]`; non-array JSON (`"42"`, `{…}`) → raw bundle; JSON array of non-file entries → raw bundle.

> **Checkpoint A1** — pure parser lands standalone with full test coverage. `make check && make test` green. Natural handoff point: everything after this builds on it.

---

## Phase A2 — `EmptyMethodSourceError` + `getMethodClosure`

- [x] In `src/errors.ts`, add `EmptyMethodSourceError extends InputPreparationError`. Carry `methodId` as a public readonly field for locality. Doc it as: "the stored method has no MTHDS source yet" — distinct from a transport failure. Set `this.name`.
- [x] Export `EmptyMethodSourceError` from `src/index.ts` (errors block).
- [x] Add `getMethodClosure(methodId: string): Promise<MthdsFileItem[]>` on `PipelexApiClient` (near `getMethod`, `src/client.ts`). Impl: `getMethod(methodId)` → `methodSourceToContents(method.mthds)` → map each content to `{ content, source: methodId }` (provenance). If the parse yields `[]`, throw `EmptyMethodSourceError(methodId)`. A `getMethod` 404 (`ApiResponseError` `not_found`) propagates as-is (covers unknown + foreign-org ids). Import `methodSourceToContents` from `./method-source.js`.
- [x] Doc on `getMethodClosure`: requires an API key (org-scoped catalog); empty source → `EmptyMethodSourceError`; unknown/foreign id → the `getMethod` 404.
- [x] Tests (`tests/` — mock the fetch boundary): resolves a raw-source method to one `{content, source}`; resolves a file-array method to N items with `source=methodId`; empty/blank source → `EmptyMethodSourceError`; unknown id (mocked 404) → `ApiResponseError` (not `EmptyMethodSourceError`).

> **Checkpoint A2** — a `method_id` can be turned into a labelled closure, with the empty-source and not-found paths typed. This is the seam the by-id callers plug into.

---

## Phase A3 — `method_id` on `prepareInputs` and `buildInputs`

Design rule: `method_id` is a **client-side convenience**, resolved to `files` before anything hits the wire. Do NOT add `method_id` to the exported wire model `BuildInputsRequest` — keep the wire type clean; accept it as a client-method param union instead. Exactly one of `files` | `method_id` is required (either/or).

- [x] **`prepareInputs`** (`src/prepare-inputs.ts`): change `PrepareInputsRequest` from an interface to a discriminated union — `{ files } | { method_id }`, each with `pipe_ref?` + `inputs`, and `never`-guarded on the other key so a caller can't pass both. Existing `{ files, inputs }` callers stay source-compatible.
  - [x] Extend `PrepareCapableClient` with `getMethodClosure(methodId: string): Promise<MthdsFileItem[]>`.
  - [x] At the top of the `prepareInputs` fn, resolve `files`: if `"method_id" in request`, `files = await client.getMethodClosure(request.method_id)`, else `files = request.files`. Then proceed exactly as today (feed `files` into `client.buildInputs(...)`). Add a runtime guard for the degenerate "neither given" case → `InputPreparationError`.
  - [x] Verify the `client.prepareInputs` wrapper method in `src/client.ts` forwards the widened request type unchanged.
- [x] **`buildInputs`** (`src/client.ts` ~`708`): widen the param to accept an alternative `{ method_id, pipe_ref?, format?, explicit? }` (no `files`/`method_ref`). When `method_id` is present, resolve via `this.getMethodClosure(method_id)` → set `files` → build the normal `BuildInputsRequest` and proceed. Keep the pure files-only path untouched.
  - [x] Confirm `buildInputs` is a build **extension**, not part of the `MTHDSProtocol` interface the client `implements` — so widening its signature doesn't break interface conformance. (Grep the protocol interface; execute/start/validate/models/version are the protocol methods.)
- [x] Tests: `prepareInputs({ method_id, inputs })` produces the **same** `PreparedInputs` as the equivalent inline-`files` call (mock `getMethodClosure` + the upload/build boundary); `buildInputs({ method_id, … })` matches `buildInputs({ files, … })`; empty-source id surfaces `EmptyMethodSourceError`; passing both `files` and `method_id` is a type error (and a runtime guard as belt-and-suspenders).

> **Checkpoint A3** — by-id input preparation works end-to-end and matches the inline-files result. The closure-resolution deliverable from the WIP doc is complete. Good point to run the full suite and a fresh read of the acceptance list.

---

## Phase B — Drift reconciliation (methods read model + phantom route)

- [ ] **Remove `deleteMethod`** — the method definition is at `src/client.ts:988` (`async deleteMethod(...)`, the `DELETE /v1/methods/{id}` wrapper). It is NOT a separate barrel export (just a class method), so nothing in `src/index.ts` references it. The only test is `tests/product.test.ts:125` ("DELETEs /v1/methods/{id} and tolerates an empty 204 body") — remove that `it(...)` block. (Breaking export change — changelog it.)
- [ ] **Add fields to `MethodData`** (`src/product-models.ts`, ~`27`): `org_id: string`, `created_by_user_id: string`, and `description?: string | null` (server-derived, present on GET/list read responses; absent on the write contract). Keep neutral field names (no `pipelex_` prefix). Leave `pipe_output` as-is — the SDK's "legacy, optional" note already matches the platform stance (kept for old rows, cleared on resave).
  - [ ] Confirm `MethodWriteInput` still matches `MethodSaveBody` (`name`, `mthds`, `input_data`) — it does; no change. `description` must NOT be added to the write input.
  - [ ] Fixtures: **no test fixture is typed as `MethodData`** (they're inline JSON literals in `jsonResponse(200, {...})` — verified: the only `: MethodData` annotation is `listMethods`'s return type in `src/client.ts`). So the two required additions do NOT break `typecheck` / `typecheck:test`. Updating the method literals in `tests/product.test.ts` (and the `methodResponse` helper in `tests/method-closure.test.ts`) to include `org_id` / `created_by_user_id` is fidelity-only — do it, but nothing goes red if a literal omits them.

> **Checkpoint B** — the SDK's methods surface is faithful to the platform contract (right fields on reads, no phantom delete). Independent of A; can be done before or after.

---

## Phase C — Docs, changelog, verification

- [ ] **`docs/input-preparation.md`**: drop the "`method_id` resolution deferred" caveat; document by-id `prepareInputs`/`buildInputs`, `getMethodClosure`, `methodSourceToContents`, the API-key requirement for by-id, and `EmptyMethodSourceError`. (Leave the separately-deferred opt-in `http(s)` ingest note intact.)
- [ ] **Methods-surface docs**: document the `MethodData` field additions and the `deleteMethod` removal wherever the product surface is described (`docs/architecture.md` or a methods section — check what exists).
- [ ] **`CHANGELOG.md`** — new `## [v0.6.0]` block at top:
  - *Added*: `methodSourceToContents` (exported canonical parser); `getMethodClosure`; by-id `method_id` on `prepareInputs`/`buildInputs`; `EmptyMethodSourceError`; `MethodData.org_id` / `.created_by_user_id` / `.description`.
  - *Changed / breaking*: removed `deleteMethod` (the hosted platform has no delete route by design).
  - Follow the repo's changelog voice (no hardcoded counts; "breaking", not "pre-1.0 breaking").
- [ ] `make check` (lint + format + typecheck + build + depcruise) green.
- [ ] `make test` green.
- [ ] Run the `contract-check` skill (methods read model + build-route shapes changed) — it's the pre-release gate for wire-surface drift.

> **Checkpoint C** — release-ready. Hand to `/release` for the version bump + CHANGELOG finalization. Do NOT self-bump `package.json`/`SDK_VERSION`.

---

## Acceptance (mirrors the WIP doc)

- [ ] `methodSourceToContents` exported + unit-tested for every source shape (raw / JSON file-array / JSON `[]` / non-array JSON / unparseable / blank / whitespace-only / null).
- [ ] `prepareInputs({ method_id, inputs })` and `buildInputs({ method_id, … })` resolve a stored method and produce the same result as the equivalent inline-`files` call.
- [ ] Empty-source path → `EmptyMethodSourceError`; unknown/foreign-org id → the `getMethod` 404 (`ApiResponseError` `not_found`), distinctly.
- [ ] `MethodData` carries `org_id`, `created_by_user_id`, `description`; `deleteMethod` is gone.
- [ ] `docs/input-preparation.md` no longer claims by-id is deferred; CHANGELOG has the `## [v0.6.0]` entry.

## Out of scope (do not do here)

- Opt-in `http(s)` → storage ingest on `prepareInputs` (separately deferred; still pass-through).
- Native `method_id`/`method_ref` on the runner's `/v1/build/inputs` and `/v1/validate` **routes** — a deeper platform-side fix. This SDK helper is the client-side intermediate; keep the consumer-facing signatures (`getMethodClosure`, `prepareInputs({method_id})`) stable so they can later delegate to a native route without a breaking change.
- Retiring `pipelex-mcp`'s `src/capabilities/method-source.ts` mirror — that happens **downstream** in `pipelex-mcp` after it bumps `@pipelex/sdk` to `^0.6.0`. Not this repo.

## Downstream (informational — after v0.6.0 ships)

`pipelex-mcp` bumps `@pipelex/sdk` to `^0.6.0`, then: builds `mthds_prepare_inputs` passing `method_id` straight through, and retires `src/capabilities/method-source.ts`, calling the SDK's canonical parser/closure helper from its by-id legs (`mthds_validate`, `mthds_inputs_template`) too — collapsing the duplicated parser to one copy.

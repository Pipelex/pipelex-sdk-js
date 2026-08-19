# Next — pure offline codegen check (`runCodegenCheck`)

Status: **planned, not started**. Reviewed 2026-08-19 against the reference implementation; the review's findings are folded in below, so this section is meant to be executable from a cold start with no prior session context. Everything below the horizontal rule is the completed `resolve()`/`codegen()` plan (PR [#24](https://github.com/Pipelex/pipelex-sdk-js/pull/24)), kept for context — its decisions log and follow-ups are still the reference for this work.

## Why

`pipelex-starter-js` is adopting `client.codegen()` to keep committed, generated `ts-zod` artifacts per method, with an offline drift check in its CI — see `../pipelex-starter-js/wip/codegen/design.md`, whose Phase 0 is exactly this helper. The check logic — the stamp grammar, the lock format, the drift taxonomy — is protocol knowledge that belongs in the SDK, not re-implemented per consumer. The spec says so directly: the check "is pure hashing, so any client (the CLI, an SDK, a short CI script) implements it identically" (`../docs/specs/pipelex-codegen.md` → "Offline check algorithm").

**The SDK is the right home, and the codegen spec settles it** rather than leaving it to taste: its "Ownership" section states that the normalized crate is standard-owned but "everything Pipelex builds on top of it is a Pipelex extension … and the stamp/lock/check trust chain". So this goes in `@pipelex/sdk`, never in `mthds`.

This does **not** reopen the "SDK stays transport-only" stance recorded in the follow-ups below: the deliberately-excluded idea was a helper that *writes* artifacts to disk. The check helper is **pure** — no filesystem, no network, no key. The caller walks its tree and hands in content; the SDK owns the verdict. Same pure-core split as pipelex's `build_stamped_projection` (pure) vs `write_stamped_projection` (local materialization), so the boundary mirrors one the engine already drew on purpose.

## Canonical references (read these first, in a fresh session)

- `../docs/specs/pipelex-codegen.md` → "Offline check algorithm" — the contract (three steps, structured verdict, dev-action/CI-action split). **The prose and the reference implementation differ in ways that matter** (see "Semantics to mirror exactly"); when they disagree, the Python code wins, because that is what produced the bytes we are checking. The section is currently marked `unverified` in conformance; it de-skeletons together with the check/stamp/lock surfaces once a published pipelex ships them.
- `../pipelex/pipelex/codegen/check.py` — the reference implementation: `run_codegen_check`, `CodegenCheckReport`, `CodegenDrift`, `DriftCategory`, and the two private workhorses `_check_present_artifact` (drift precedence) and `_find_orphans` (orphan predicate).
- `../pipelex/pipelex/codegen/stamp.py` — the stamp grammar (`>>> pipelex-codegen-stamp >>>` / `<<< … <<<` fences, comment prefix by suffix: `.ts` → `//`, `.py` → `#`, `STAMPABLE_SUFFIXES`), plus `compute_content_hash`, `parse_stamped`, `has_stamp`.
- `../pipelex/pipelex/codegen/lock.py` — the lock model (`crate_fingerprint`, `engine_version`, `[[artifacts]]` of `{ path, content_hash }`), `validate_artifact_path`'s rules, and `validate_artifact_paths`'s duplicate rejection.
- `../pipelex/pipelex/codegen/emission.py` — where the lock hash comes from: `build_stamped_projection` hashes `emitted_file.content` **before** stamping, which is why the lock hash and the stamp hash are the same value.
- `../pipelex-starter-js/wip/codegen/design.md` — the first consumer's design; shows the intended call site (`scripts/codegen-check.mts` walks `src/generated/<method>/`, the SDK returns the verdict per tree) and its D4, which documents the Prettier collision this repo has to dodge too.

## Cold-start orientation — the state of this repo

- One runtime dependency: `mthds@^0.22.0`. The barrel `src/index.ts` is the single public entry (`exports` has only `"."`), and it is client-bundler-safe today (fetch-based, no Node builtins in the graph).
- `make check` = `lint` (eslint over `src/ tests/`) + `format:check` (prettier over `src/**/*.ts`, `tests/**/*.ts`, `*.ts`) + `typecheck` + `typecheck:test` (`tsconfig.test.json`, which includes `tests/**/*.ts`) + `build` + `depcruise`. All five touch `tests/` — see the fixture decision below.
- `.dependency-cruiser.cjs` forbids only imports resolving under `node_modules/mthds/` outside the `protocol` subpath, so a new third-party dependency needs no config change.
- `src/models.ts` already defines everything the e2e needs: `CodegenValidReport` carries `artifacts`, `lock`, `lock_filename`, `crate_fingerprint`, `engine_version`, and `GeneratedArtifact` is `{ path: string; content: string }` — **structurally identical to the tree-file input below**, so the e2e feeds `report.artifacts` straight in with no mapping. Keep it that way.
- `tests/e2e/crate.e2e.ts` already exercises all three `CodegenTarget` members against a live `pipelex-api`; `make test-e2e` reads `PIPELEX_E2E_BASE_URL` (default `http://localhost:8081`).

## Semantics to mirror exactly

- **Categories are exactly** `"missing" | "modified" | "hand-edited" | "orphan"` — note `hand-edited` is hyphenated in the canonical `DriftCategory`; do not snake_case it.
- **Text is read with universal newlines, not as raw bytes.** `load_text_from_path` is `Path.read_text(encoding="utf-8")`, so `\r\n` and lone `\r` become `\n` before anything is parsed or hashed. Mirror this (`runCodegenCheck` does) or the port disagrees with the CLI on every Windows-written or `autocrlf`-checked-out tree — see the caller-contract correction below.
- **One hash, two uses.** SHA-256 hex (lowercase) over the UTF-8 bytes of the **body below the stamp**. The lock's `content_hash` is that same body hash — `emission.py` hashes `emitted_file.content` before stamping — so the lock-vs-disk and stamp-vs-disk comparisons agree on the same bytes.
- **At most one drift per locked path, and `hand-edited` outranks `modified`.** This is *not* derivable from the spec's three-step prose, which reads as two independent passes. `_check_present_artifact` returns early: no parseable stamp → `hand-edited`; stamp's recorded hash ≠ recomputed body hash → `hand-edited`; only then body hash ≠ locked hash → `modified`. A hand edit trips both conditions, and upstream reports it once, as `hand-edited`. An implementation written from the prose emits two drifts and diverges. Pin it with a test.
- **The orphan predicate is `has_stamp`, not `parse_stamped`.** `_find_orphans` only checks that the text starts with the begin-marker line for that suffix's comment prefix — a stamped-but-corrupt stray still counts as an orphan. Using the stronger parse here would silently ignore exactly the stale file the lock exists to catch.
- **Orphan = stampable suffix + stamped + untracked.** Files whose suffix is not in `STAMPABLE_SUFFIXES` are skipped, not errors — the starter deliberately parks a `sources.json` sidecar beside the lock and relies on this. Never call the comment-prefix lookup on an unknown suffix (upstream it raises); skip first.
- **Drift ordering is deterministic and must be reproduced**: locked-artifact drifts first, sorted by path (`sorted(lock.hash_by_path().items())`), then orphans, sorted by path (the walk is a sorted pre-order). Tests will depend on it and consumers print it.
- **`isCurrent` is `drifts.length === 0`** (Python's `lock_found and not drifts`, with `lock_found` dropped — see the API notes).
- **No verdict ≠ drift.** An unparseable lock, an invalid artifact path, or a duplicate artifact path is a typed error (mirror `CodegenLockError`), not a drift report — the caller maps it to its exit-2 path, per the CLI exit-code policy the spec pins.
- **The non-UTF-8 → `hand-edited` branch is unreachable here** and is deliberately dropped: `content` is already a `string`, so the caller has already decoded. Say so in the TSDoc and tell the caller what to do with a file it could not decode (report it itself, or omit it and accept a `missing`).
- **What the check deliberately does NOT do.** It never compares a stamp's `crate_fingerprint` against the lock's, and it never re-resolves the crate — that needs the engine, which is the whole point of the offline split. Keep parity: do not add either check. (The report *exposes* the lock header so a caller can compare against a live `codegen()` response itself — see below.)

## The caller contract — document it on the function and in the docs page

The pure input moves three obligations onto the caller. Each one, if unmet, produces a *wrong* verdict rather than an error, so none of them can be left implicit:

- **Pass the file text as read, without reformatting it.** No BOM stripping, no re-encoding, no running a formatter over an artifact. The hash is over exact UTF-8 bytes and `parse_stamped` requires the text to *start with* the begin-marker line. **Line endings are the exception** — see the next bullet.
- **~~Warn about `core.autocrlf`~~ — CORRECTED at Checkpoint 1; the original claim here was wrong.** pipelex reads artifacts through `Path.read_text()`, whose universal-newline translation means the reference check never sees a `\r`; it reports a fully CRLF-rewritten tree as *current*, and on Windows pipelex itself writes CRLF files whose locked hashes are over LF. So `runCodegenCheck` normalizes `\r\n` and lone `\r` to `\n` before parsing or hashing, and a `core.autocrlf=true` checkout is **not** a false hand-edit. `.gitattributes` (`src/generated/** -text`) remains worth recommending for diff hygiene, not for correctness. See the decisions log.
- **Walk the whole tree, recursively, from the lock's directory.** An incomplete `files` list yields `isCurrent: true` — a false negative on precisely the drift class orphan detection exists for. To make the caller's walk agree with ours, **export the stampable-suffix set** (or an `isStampableArtifactPath(path)` helper) so the consumer filters identically to `_iter_stampable_files`. Upstream also prunes vendor/VCS directories and skips symlinks; that is walk policy and stays with the caller, but the docs should name it (the starter's per-method directories make it moot — say that too).

## API sketch

```ts
// src/codegen-check.ts — pure: no fs, no fetch, no node builtins.
// Imports nothing but `smol-toml`; it does not import the client/transport side.

export type CodegenDriftCategory = "missing" | "modified" | "hand-edited" | "orphan";

export interface CodegenDrift {
  path: string;
  category: CodegenDriftCategory;
  detail: string;
}

export interface CodegenCheckReport {
  drifts: CodegenDrift[];
  isCurrent: boolean;
  /** From the lock header — lets a caller compare a committed tree against a live `codegen()` response. */
  crateFingerprint: string;
  engineVersion: string;
}

/** Structurally identical to `GeneratedArtifact`, so a `codegen()` response feeds in unmapped. */
export interface CodegenTreeFile {
  path: string; // relative to the lock's directory, forward slashes, canonical (no "./", no "..")
  content: string; // byte-exact UTF-8 text
}

export function runCodegenCheck(input: {
  lockContent: string;
  files: readonly CodegenTreeFile[];
}): Promise<CodegenCheckReport>;

/** The suffixes codegen stamps — mirror of pipelex's `STAMPABLE_SUFFIXES`, so a caller's walk agrees with ours. */
export const STAMPABLE_ARTIFACT_SUFFIXES: readonly string[];
export function isStampableArtifactPath(path: string): boolean;

/** No-verdict conditions: a malformed lock, an unsafe/duplicate artifact path, a non-canonical input path. */
export class CodegenLockError extends Error {}
```

- **Async, via WebCrypto.** Hash with `globalThis.crypto.subtle.digest`, **not** `node:crypto` — the barrel is client-safe today (`pipelex-starter-js` bundles it into client components and documents that guarantee), and this helper must not be the import that breaks a client bundler. WebCrypto exists in every supported Node (the `engines` floor is 22.12) and every browser. Note the browser caveat in the docs: `crypto.subtle` is secure-context-only (https / localhost), which is a non-issue for a CI helper but should not surprise anyone.
- **A missing lock is the caller's concern.** Pure input means the caller already located `codegen.lock` (or didn't); `lockContent` is required and the report drops Python's `lock_found` field.
- **Validate the input paths, not just the lock's.** Upstream's tree walk cannot produce duplicates or a `"./types.ts"` spelling; a caller-supplied array can, and `"./types.ts"` silently produces a `missing` *and* an `orphan` for the same file. Run the input paths through the same canonical-path rules as `validate_artifact_path`, and reject duplicates the way `validate_artifact_paths` does — as a `CodegenLockError`, not a drift.
- **Field names are camelCase** (this is an SDK-computed report, not a wire mirror) but category *values* stay the canonical strings.

## Decisions taken in review (2026-08-19) — do not re-litigate

- **TOML: take `smol-toml` as a direct dependency; do not hand-roll a parser.** The earlier lean toward hand-rolling rested on "keeps the dependency set untouched" — and that premise is false: `mthds@0.22.0` already depends on `smol-toml@^1.6.0`, so it is *already hoisted in this repo's `node_modules` and in every consumer's install tree*. Declaring it directly adds zero packages; it dedupes against what `mthds` already pulls. It is itself dependency-free, ESM, and platform-neutral, so the client-safe guarantee is untouched, and `depcruise` needs no rule change. What hand-rolling would actually buy is a second TOML implementation owning basic-string escapes, quoted keys, and comment handling — a correctness liability against the workspace's "solid over quick" principle. (Do **not** rely on the transitive resolution: add it to `dependencies` explicitly.)
- **`CodegenLockError extends Error`, defined in `src/codegen-check.ts`, re-exported from the barrel** — *not* in `src/errors.ts` and *not* deriving from `PipelineRequestError`. It is not a request error, and `errors.ts` imports `mthds/protocol`; keeping the error local is what lets the check module stand alone with `smol-toml` as its only import (and keeps the subpath option below cheap). `ClientAuthenticationError extends Error` in `errors.ts` is precedent that not every SDK error derives from the protocol base.
- **Name: `runCodegenCheck`** — parity with `run_codegen_check` beats accuracy about whether anything is "run".
- **Docs: extend `docs/crate-routes.md`** rather than adding a page. That page already narrates the trust chain in "`codegen` — stamped artifacts and the trust chain"; the offline check is its second half, and splitting them means neither page tells the whole story. Add a section after it, plus the caller-contract block.
- **The report exposes `crateFingerprint` / `engineVersion`.** Nearly free once the lock is parsed, and it is what lets a consumer compare a committed tree against a live `codegen()` response — the gap the starter otherwise fills with a `sources.json` sidecar. This does not change the check itself (see parity note above).
- **Fixtures must not carry a `.ts` extension.** Vendoring `types.ts` under `tests/fixtures/` walks into three gates at once: `format:check` globs `tests/**/*.ts` and this repo prints at `printWidth: 100` while the ts-zod emitter targets Prettier's 80-column default (the starter's D4 documents the same collision), `lint` runs eslint over `tests/`, and `tsconfig.test.json` includes `tests/**/*.ts` — where a fixture importing `zod` fails typecheck, since `zod` is not a dependency here. Any of the three rewrites or reddens the fixture, and a rewritten byte invalidates the very hash the fixture exists to pin. Store them as `types.ts.txt` / `binder.ts.txt` and map the name back to `types.ts` when building the tree in the test. This clears all three gates without touching any ignore file, so nobody can undo it by "tidying" an ignore list later. (`codegen.lock` needs no disguise — no gate matches it.)

## Open decision — SETTLED (see the decisions log for the reasoning)

- **Subpath export vs the single barrel** → **the single barrel, plus `"sideEffects": false` in `package.json`.**

## Phases

### Phase 1 — module + barrel — DONE

- [x] Add `smol-toml` to `dependencies` (`^1.6.0` — mthds's own range, so the two resolve to one copy; `package-lock.json` carries a single entry).
- [x] `src/codegen-check.ts`: the lock parser (strict shape validation on top of `smol-toml`, mirroring `CodegenLock` + `validate_artifact_paths`), the stamp parser (port of `parse_stamped` and `has_stamp` for `//` and `#` prefixes), the WebCrypto hash, the canonical/duplicate input-path validation, and the three-step algorithm with the precedence and ordering pinned above.
- [x] Export the function, its types, `CodegenLockError`, and the stampable-suffix surface from `src/index.ts`; `make check` green including depcruise (the module imports only `smol-toml` — nothing from the client/transport side).

### Phase 2 — unit tests — DONE

- [x] Vendor a fixture trio (`types.ts.txt` + `binder.ts.txt` + `codegen.lock`) generated from a local `pipelex codegen types` run (v0.46.4), committed under `tests/fixtures/codegen/ts-zod/` with the source bundle (`smoke.mthds`) and a `README.md` recording the exact regeneration commands. `make check` is green **with the fixtures committed** — the extension choice holds.
- [x] Vendor a `.py` fixture too (`python-pydantic/models.py.txt`), so the `#` comment prefix is covered by unit tests and not only by the e2e. Same crate, so the two flavors share a `crate_fingerprint` — asserted, since the fingerprint is a property of the crate and not of the projection.
- [x] `tests/codegen-check.test.ts`: a current tree reports `isCurrent` with no drifts and surfaces `crateFingerprint` / `engineVersion`; each category triggers (drop a file → `missing`; regenerate a body *with its stamp* against a stale lock → `modified`; strip, truncate, or edit below a stamp → `hand-edited`; add a stamped stray → `orphan`).
- [x] Pin the review findings explicitly: a hand-edit yields **exactly one** drift and it is `hand-edited` (not also `modified`); a stray whose stamp is corrupt below the begin marker is still an `orphan`; drift order is locked-then-orphan, each sorted by path; a `#`-stamped stray in a TypeScript tree is detected by its own suffix.
- [x] Pin the caller-contract failures: an unstamped stray is ignored; a non-stampable suffix is ignored (even one that opens like a stamp); a `"./types.ts"` input path and a duplicate path each throw `CodegenLockError`; a malformed lock, an unknown lock key, and an artifact path that is absolute / drive-prefixed / backslashed / control-charactered / `..`-bearing / empty / wrong-suffixed each throw `CodegenLockError` — each case asserting the *rule* that fired, not just the class.
- [x] ~~Pin the CRLF failure mode~~ — **the plan's premise was wrong; see the decisions log.** The suite now pins the verified behaviour instead: a fully CRLF-rewritten tree is **current**, and a hand edit inside a CRLF tree is still caught.

**Checkpoint 1** — ✅ `make check` + `make test` green (all unit suites, fixtures committed). The port was verified differentially against the real `pipelex codegen check` (v0.46.4) on identical trees: every drift category, the hand-edit precedence, the locked-then-orphan ordering, and the CRLF case all agree. Decisions recorded below. Phase 3 (e2e against a live `pipelex-api`) and Phase 4 (docs, changelog, release) are next.

### Phase 3 — e2e

- [ ] Extend `tests/e2e/crate.e2e.ts`: call `codegen()` live, run `runCodegenCheck` over the returned `artifacts` + `lock` verbatim → current (and assert `crateFingerprint` equals the response's `crate_fingerprint`); then mutate in-memory per category. This is what pins the hash and grammar port against the server's real stamp and lock bytes, the same way the live run pinned the `kind`/`target` vocabulary.
- [ ] Do it for a `.py` target as well as `ts-zod`, since the suite already calls all three — that pins the `#` prefix against real server bytes too.

### Phase 4 — docs + changelog + release

- [ ] Extend `docs/crate-routes.md` per the decision above: the algorithm, the drift taxonomy, the caller contract (unreformatted text, the complete walk, the newline-normalization rule and why it exists), and what the check deliberately does not verify. **Do not write the CRLF warning the plan originally called for — it was wrong; see the decisions log.**
- [ ] `docs/architecture.md` surface list + the new module; `CHANGELOG.md` `[Unreleased]` Added (the helper, its types, and the new `smol-toml` dependency); README status line.
- [ ] Release (via the `/release` skill, which owns the version bump), so `pipelex-starter-js` can pin its range to the version carrying the helper and proceed with its Phase 1.

## Decisions log

**Checkpoint 1** (Phases 1–2):

- **CRLF: the plan's premise was wrong, and the fix inverted the behaviour.** The plan (and its caller-contract section) asserted that a CRLF-rewritten artifact reports `hand-edited`, that a `.gitattributes` entry is therefore load-bearing, and that "pipelex's own check has the same exposure". It does not. `load_text_from_path` is `Path.read_text(encoding="utf-8")`, whose default `newline=None` applies **Python universal-newline translation**, so the reference check never sees a `\r` — its verdict is over line-ending-normalized text, not raw bytes. The same default on the write side means pipelex running on Windows *emits* CRLF artifacts whose locked hashes were computed over LF. Verified empirically: `pipelex codegen check` reports "up to date" for a fully CRLF-rewritten tree. A byte-exact port would have reddened consumer CI on precisely the trees the CLI passes, so `runCodegenCheck` normalizes `\r\n` and lone `\r` to `\n` on both the lock and every file before parsing or hashing. `.gitattributes` is now recommended for diff hygiene only — **Phase 4 must not repeat the plan's claim.**
- **Subpath export → the single barrel wins, with `"sideEffects": false` added.** With the module written, the concern the subpath was meant to protect against is gone: it imports only `smol-toml` (dependency-free, ESM, platform-neutral) and hashes through WebCrypto, so nothing in its graph can break a client bundler. That left only tree-shaking, which the new `"sideEffects": false` declares for the whole package (verified safe — no `src/` module has a top-level side effect). Keeping one import source beats a second entry point that exists solely to hedge.
- **`smol-toml` declared at `^1.6.0`, not the `^1.8.0` npm writes by default.** `^1.6.0` is mthds's own range, so the direct dependency can never resolve to a second copy alongside the transitive one; `package-lock.json` carries a single `node_modules/smol-toml` entry.
- **Fixtures generated from the local `pipelex` CLI, not from a live `codegen()` call.** Same bytes (the route projects the same engine), no API key or network in the unit suite, and the source bundle commits alongside so they are reproducible. Pinning against *server* bytes is Phase 3's job — the same division the crate routes already use.
- **The port was verified differentially against the reference CLI**, not only against its source. Each mutation was applied to a real generated tree on disk, run through `pipelex codegen check` v0.46.4, and compared: `missing`, `modified` (body **and** stamp regenerated against a stale lock — the only way to reach it, since a plain body edit trips the stamp check first), `hand-edited`, `orphan`, the corrupt-stamp orphan, an unstamped stray and a `sources.json` sidecar (both ignored), the CRLF tree, and the four-drift ordering including a cross-suffix orphan. All agree. This is what turned up the CRLF finding.
- **Drift `detail` strings are upstream's, verbatim** — including "Locked artifact is absent on disk.", which is worded for a filesystem the pure helper never touches. Parity is worth more than the wording: a consumer that switches between `pipelex codegen check` and this helper reads the same report.
- **Lock shape validation is strict (`extra="forbid"` mirrored); the stamp's projection vocabulary is not.** An unknown key in the lock is a malformed lock — the lock is Pipelex-owned, written by a versioned engine, and an unrecognized shape means the two disagree about what the hashes cover. The stamp is the opposite case: pipelex validates `kind` / `target` against its own enums, which cannot lag its own emitter, while an SDK copy *can* — so the port requires the projection line to be present and well-formed but does not check its values against `CodegenKind` / `CodegenTarget`. Rejecting an unknown-but-valid future `kind` would report every artifact as `hand-edited`. For today's vocabulary the two behave identically.
- **The suffix rule applies to lock paths only, not to supplied tree paths.** Both go through the canonical-path rules (empty / backslash / control character / absolute / drive prefix / `.` / `..`), but a tree file of a non-stampable type is legitimately present and is skipped, not rejected — that is what lets a consumer park a `sources.json` sidecar beside the lock, and the TODO's own "a non-stampable suffix is ignored" test would otherwise contradict its "run input paths through `validate_artifact_path`" line.
- **Orphans are sorted by path string.** Upstream's order is a sorted pre-order directory walk, which differs from a plain path sort only when a directory name is a prefix of a sibling file name (`a/b.ts` vs `a.ts`). The helper takes a flat list and has no directory structure to walk, so the string sort is the honest deterministic rule.

---

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
- [ ] Consider a convenience helper that writes `artifacts` + lock to disk — deliberately **not** in this change; the SDK stays transport-only for now. (The pure offline *check* helper is now planned — see the `runCodegenCheck` section at the top; it keeps this stance, since it never touches the filesystem.)
- [ ] By-id (`method_id`) sugar on `resolve`/`codegen` — deferred, see [`wip/crate-routes-method-id-sugar.md`](./wip/crate-routes-method-id-sugar.md).
- [ ] **Expose `/v1/resolve`, `/v1/codegen` (and the pre-existing `/v1/lint`, `/v1/format`) on `api.pipelex.com`** — cross-repo (`pipelex-api-infra` allowlist + `pipelex-platform` tooling proxy). **Partially shipped 2026-08-13, re-verified 2026-08-19:** the two crate routes work on `api-dev.pipelex.com` (now `pipelex-hosted@0.9.0`, first seen on `0.2.8` — the exposure survived a redeploy), verdict discipline intact. Still open: prod (on `0.2.6`, awaiting the deploy — no further code change needed) and **`lint` / `format`, which were left out of the allowlist change and still 403 on both origins** — exactly the "fix all four at once" trap the note warned about. Tracked in [`wip/hosted-exposure-crate-and-tools-routes.md`](./wip/hosted-exposure-crate-and-tools-routes.md).
- [ ] **`ValidationErrorItem` is missing `missing_pipe_code` + `suggested_fix`** — pre-existing drift on the shared invalid arm, so it now touches these routes too. Deferred because closing it properly means porting the `SuggestedFix`/`FixOp`/`FixSafety` family; see [`wip/validation-error-item-drift.md`](./wip/validation-error-item-drift.md).

## Decisions log

**Checkpoint 1** (Phases 1–3):

- **`CrateRequestBase` vs reuse of `BuildRequestBase`** → new `CrateRequestBase`, and `BuildRequestBase` now **extends** it rather than restating `files`/`method_ref`. The plan leaned toward leaving `BuildRequestBase` untouched to avoid forced inheritance, but the inheritance here is not forced: it is exactly the server's own hierarchy (`MthdsPipeRequest(MthdsFilesRequest)`), so the build envelope genuinely *is* the crate envelope plus `pipe_ref`. Structurally identical for consumers (TypeScript interfaces are structural), one place documents the selector, and the two families cannot drift on it.
- **XOR not modelled in the type system** — `CrateRequestBase` keeps both selectors optional rather than becoming a discriminated union. The union would force the overwhelmingly common `{ files }` call site to satisfy a branch for no gain, and the server rejects both illegal shapes (neither / both) with a request-shape 422 that already surfaces as a typed `ApiResponseError`.
- **By-id `method_id` sugar → deferred.** `buildInputs` has it because `prepareInputs` needs it internally; nothing in this change does. The workaround is a single line (`resolve({ files: await client.getMethodClosure(id) })`), documented in the `resolve` TSDoc, whereas the sugar costs a second param type per method, a runtime guard for JS callers, and its own tests. Revisit when a real consumer asks. Note written to `wip/crate-routes-method-id-sugar.md`.
- **Test/docs file placement** → `tests/crate-routes.test.ts` and `docs/crate-routes.md`, both new. `tests/build-routes.test.ts` is already large and pins a different envelope (`pipe_ref` defaulting); `docs/build-routes.md` is about the per-pipe projections, while the crate routes' story is the crate + the codegen trust chain. The shared pieces (`CrateInvalidReport`, verdict discipline) get cross-links rather than a copy.

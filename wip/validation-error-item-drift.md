# Closed — `ValidationErrorItem` was missing two server fields

**Status:** closed. Surfaced during the crate-routes review (PR #24), carried as a deferral, and resolved while mirroring the `pipelex` 0.52 / `pipelex-api` 0.17 validation-report surface. See "How it was closed" at the bottom; the analysis below is kept because it is what a reviewer reads to understand why the shape is what it is.

## The drift

`src/models.ts`'s `ValidationErrorItem` mirrors pipelex's `ValidationErrorItem` (`pipelex/pipelex/base_exceptions.py`). Two fields the server can send are absent from the TypeScript type:

- **`missing_pipe_code`** — a plain `string`, symmetrical with the `missing_concept_code` the SDK already declares.
- **`suggested_fix`** — the server's deterministic repair proposal. This one is not a scalar: it pulls in a `SuggestedFix` shape plus its `FixOp` and `FixSafety` vocabularies.

The type carries no index signature, so a consumer wanting either must cast the item.

## Blast radius

The item rides three surfaces, all of which are affected equally: `/v1/validate`'s invalid arm (`PipelexInvalidReport.validation_errors[]`), the build routes' `CrateInvalidReport`, and — as of PR #24 — `/v1/resolve` and `/v1/codegen`, which share that same invalid arm.

## Why it was not fixed in PR #24

Adding `missing_pipe_code` alone is a one-line change, but it would leave the drift half-closed while implying the type is now complete — the worse of the two states. Closing it properly means porting the `SuggestedFix` / `FixOp` / `FixSafety` family, which is its own change with its own tests, and touches the `/v1/validate` surface that PR #24 deliberately did not go near.

## What to do

One change that ports both fields together:

1. Add `missing_pipe_code?: string`.
2. Port `SuggestedFix` (with `FixOp` / `FixSafety`) as exported types, mirroring the server vocabularies exactly, and add `suggested_fix?: SuggestedFix`.
3. Export them from the barrel and pin the shapes against the server models the way the crate routes' e2e suite does — a live invalid-verdict call that asserts the structured locators survive the wire.

Check `pipelex-sdk-python`'s mirror at the same time: if it is also partial, the two SDKs should close the gap together so consumers see one contract.

## How it was closed

Both fields landed together in the change that mirrored the `pipelex` 0.52 / `pipelex-api` 0.17 validation-report surface, following steps 1 and 2 and the barrel half of step 3: `missing_pipe_code`, `suggested_fix`, and the `SuggestedFix` / `FixOp` / `FixSafety` family ported as exported types in `src/models.ts` and named in the barrel, with the `FixOp` union discriminated on `kind` over the seven patch kinds.

What forced the timing was the fourth surface. `PipelexValidationReport.warnings` — the advisory lints on a **valid** bundle — is typed with this same item, so the drift stopped being confined to the invalid arm. That addition also surfaced something the original note did not know: the two channels serialize an unset locator differently. The invalid arm and the crate routes drop the key (`exclude_none` server-side); the valid arm does not, so the identical item arrives inside `warnings[]` with explicit `null`s. Every optional member is therefore `?: T | null` rather than `?: T`, and a regression test pins the null-bearing warning item.

Two upstream invariants a TypeScript type cannot carry are recorded as doc comments instead: `"*"` is the wildcard path segment, refused as a `key` on every kind but `remap_value`; `ensure_table` and `delete_table` require a non-empty `table_path`.

Still open, and genuinely separate. Step 3's live half was never attempted: the shapes are pinned against mocked `/v1/validate` bodies in `tests/client.test.ts`, and no e2e call asserts a populated `suggested_fix` survives the wire — the invalid arm in `tests/e2e/tools.e2e.ts` still checks only `category` and `message`. The `pipelex-sdk-python` mirror named above also remains unchecked for the same partiality.

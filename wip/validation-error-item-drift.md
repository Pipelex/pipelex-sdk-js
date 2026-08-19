# Deferred — `ValidationErrorItem` is missing two server fields

**Status:** open, pre-existing. Surfaced during the crate-routes review (PR #24), but it is not introduced by that change — the SDK's `ValidationErrorItem` has been a partial mirror since it landed.

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

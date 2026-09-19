---
status: active
item: L-260918-80bd71
---

# Deferred from the review of the run-results fields

Round 1 at profile 2, bar `open`, on `feature/Run-results-fields`. Everything the bar admits was fixed in place. This is what was left, and why.

## The blocking mapper dereferences `pipe_output` without a guard

`mapRunResultToRunResults` in `src/client.ts` reads `response.pipe_output["graph_spec"]`, `["graph_assembly_error"]`, `["tokens_usages"]` and `["usage_assembly_error"]` off a value it never checks. `PipelexExecuteResult` declares `readonly pipe_output: DictPipeOutput`, non-nullable, so the type system is satisfied — but the class constructor assigns `raw.pipe_output` straight through with no guard, so a blocking response that omits the key yields `undefined` and every one of those reads throws a `TypeError` rather than producing a run result with null fields. The class's own `main_stuff` getter guards with `this.pipe_output?.`, which is the same object read two different ways in the same file.

**Why it was not fixed here.** The condition predates this branch: the `tokens_usages` and `usage_assembly_error` reads are already on `dev` and throw on exactly the same access, so the two lines this branch adds sit in the same object literal and widen no exposure. Deciding what the mapper should do when the runner sends no `pipe_output` — throw a typed error naming the malformed response, or normalise to a result whose lifted fields are all null — is a behaviour change on the blocking path, which is not what a run-results surface item is for. The reviewer that raised it had the wrong type in its reasoning; the underlying condition is real and was checked against `src/execute-result.ts` and the constructor.

## Not deferred, and deliberately not acted on

The `describe("RunResults graph fields")` block in `tests/runs.test.ts` builds its literals by hand, so its assertions are tautological at runtime and its value is entirely compile-time: it pins the field's optionality under `typecheck:test`. That is what the neighbouring `TokensUsageRecord` block does too, so it is consistent with the file rather than a defect in it. The coverage that matters for the two lifts is in `tests/client-lifecycle.test.ts`, which runs through the mapper and would have failed before this change.

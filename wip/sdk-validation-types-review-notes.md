# `feature/Sdk-validation-types` review triage — deferred findings

This branch makes `ValidationErrorItem` carry an unknown model's `model_reference`, `model_type` and `suggestions`, pinned to `mthds`'s declarations by a type-level test. It is stacked on `feature/Failed-run-report-js` (PR #77), and its first review pass, at commit `436ef46` with cubic, Codex (review and adversarial) and the bundled code-review, diffed it against `dev`, so the reviewers read #77's changes as well as its own. The findings below are about #77's code, outside this branch's item, so they are deferred here rather than fixed. **None was verified**: each rests on one reviewer's reading.

## Deferred, unverified: the `failed` arm accepts a status that is not a failure

**Reporters:** the bundled code-review (low) in the first pass, and Codex's review (P3) in the second pass at commit `e0503d6`, on `src/client.ts` (`runResultFailed` / `knownRunStatus`). Two reviewers agree, but neither shows the platform sending such a 409, so it stays unverified.

The `failed` arm of the results read accepts any status in `KNOWN_RUN_STATUSES`, which includes `COMPLETED`, `RUNNING`, `PENDING` and `STARTED`. A 409 whose `run_status` or `detail` names one of those would become `state: "failed"` with that status, and `pollUntilResult` or the artifact download would throw `RunFailedError` with `status: "COMPLETED"`, where the documented fallback says such a 409 reads as `FAILED`. The proposed fix is to accept only the terminal failure statuses (`FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`) and fall back to `FAILED` for anything else.

## Deferred, unverified: "every non-2xx answer throws an `ApiResponseError`" is too broad

**Reporter:** cubic (P3), on `docs/errors.md` (the opening of "A refused request") and `README.md`.

The results read's 409 and 503 come back as the `failed` and `running` states rather than thrown, a lifecycle route's code-less 404 throws `RunLifecycleUnavailableError`, and `execute`'s gateway 503 or 504 becomes a `PipelineExecuteTimeoutError`. The sentence should name those exceptions.

## Deferred, unverified: the branching example never shows the platform's field errors

**Reporter:** cubic (P3), on `docs/errors.md` (the `createPipelexApiKey` example).

The example prints `err.errors` only under `err.errorDomain === "input"`, while the same page says the platform does not emit `error_domain` yet and `errors[]` is a platform member, so a platform `validation_failed` 422 always falls into the generic branch and its field errors are never shown.

## Deferred, unverified: a hardcoded count in `docs/errors.md`

**Reporter:** cubic (P3), in the second pass at commit `e0503d6`, on `docs/errors.md` ("The report reaches you in four places").

The workspace's writing rule forbids counts in docs, and the sentence goes stale when another surface starts carrying `RunErrorReport`. "In each of these places" stays true as the table grows.

## Already traced elsewhere

The code-review also raised that the `RunErrorReport` widening is not marked `(Breaking)` in the changelog; `wip/pr-77-review-notes.md` already defers it.

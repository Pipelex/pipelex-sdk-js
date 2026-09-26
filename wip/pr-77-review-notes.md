# PR #77 review triage — deferred findings of the third pass

[PR #77](https://github.com/Pipelex/pipelex-sdk-js/pull/77) carries a failed run's stored error report and a problem document's members. Its third review pass, at commit `4e8f944` with cubic, Codex (review and adversarial) and the bundled code-review, ran at the ladder's `necessity` bar, which fixes only a defect the previous pass introduced or one severe enough that the branch cannot ship without it. Two findings fell short of that bar and are deferred here. **Neither was verified**: each rests on cubic's reading alone.

## Deferred, unverified: the `RunErrorReport` widening is not marked `(Breaking)`

**Reporter:** cubic (P3), on `CHANGELOG.md`.

`RunErrorReport.message` and `error_type` were typed `string` (optional) and are now `string | null` (optional), like every field of the report. The type reaches `PipelineRun.error` on `listRuns`, `iterateRuns` and `getRunDetail`, so code such as `const m: string | undefined = run.error?.message` stops compiling under strict TypeScript. The changelog lists the reshaped report under `### Added` without the `(Breaking)` marker the workspace's changelog rule asks for; the Python twin files the same reshaping under `### Changed` as Breaking. The fix is to move the report bullet under `### Changed` with `(Breaking)`, saying that its fields now admit `null`.

## Deferred, unverified: "the same names and types as `mthds`" is too broad for `validationErrors`

**Reporter:** cubic (P3), on `src/errors.ts`.

The `ApiResponseError` JSDoc, the changelog's `Added` bullet and `docs/architecture.md` say the members `mthds`'s `ApiResponseError` carries have the same names and types here, and `docs/architecture.md` adds that a type-level test pins this. That is true of the problem members the test pins (`type`, `title`, `instance`, `requestId`, `errorDomain`, `retryable`, `userAction`, through `ProblemDetails` and `UserAction`), and not of `validationErrors`: this SDK types its items with its own `ValidationErrorItem` (`src/models.ts`), whose fields are nullable and which adds `missing_pipe_code` and `suggested_fix`, so the class as a whole is not assignable to `mthds`'s. `docs/errors.md` already states the narrower claim; the other three texts should say the same, naming the problem members rather than every overlapping member.

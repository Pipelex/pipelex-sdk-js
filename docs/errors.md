# Errors — a failed run's report and a refused request's problem

Two things can go wrong when you call the hosted API, and the SDK hands each one back whole. A **run can fail** after it started: the runner stores why, as its error report, and the SDK gives you that report on the failed run. A **request can be refused**: the server answers a non-2xx RFC 9457 problem document, and the SDK throws an `ApiResponseError` carrying every member of it. This page covers both: which fields each carries, which ones a program branches on, which ones a person reads, and which one support asks for. Either can carry validation items, the structured account of a method refused for what it says, which the [last section](#a-validation-item--validationerroritem) describes.

The shapes are not this SDK's invention. The report is the runner's `ErrorReport` (in `pipelex`), stored and served by the platform exactly as the runner wrote it, and the problem members are the ones the workspace's hosted-envelope spec names. The types live in `src/error-models.ts`; `pipelex-sdk` (Python) carries the same fields under snake_case names.

## A failed run — `RunErrorReport`

A run that ends without completing (`FAILED`, `CANCELLED`, `TERMINATED` or `TIMED_OUT`) has no result, and the results read answers `409`. The body of that `409` says why: its `detail` names the status and then the report's message, its `run_status` member holds the status, and its `error` member holds the run's stored error report, or `null` when the run has none. The SDK reads the status from `run_status`, falling back to the status word of the `detail` sentence on a platform that does not send the member yet, and types the report as `RunErrorReport`.

The report reaches you in four places, always the same object:

| Where | What you get |
|---|---|
| `getRunResult(runId)` | the `failed` arm: `{ state: "failed", pipeline_run_id, status, message, error }` |
| `waitForResult`, `startAndWaitForResult` on the hosted API, `downloadArtifacts({ run_id })` | a thrown `RunFailedError` with `runId`, `status`, `message` and `error` |
| `getRunStatus(runId)` | `RunRead.error` on the run record |
| `listRuns`, `iterateRuns`, `getRunDetail` | `PipelineRun.error` on each run record |

**A bare runner has no durable run, so its failure is a refused request.** Against a bare `pipelex-api` runner, `startAndWaitForResult` runs the method with the blocking `execute`, and a run that fails there answers a non-2xx problem document: the call throws an `ApiResponseError`, not a `RunFailedError`, and the same classification rides its members (`errorDomain`, `type`, `retryable`, `userAction`, `errorType`, `model`, …) as described [below](#a-refused-request--apiresponseerror). A caller that must work against both catches both, as the example does.

```ts
import { ApiResponseError, RunFailedError } from "@pipelex/sdk";

try {
  const result = await client.startAndWaitForResult({ method_id: "mt_abc123", inputs });
  console.log(result.main_stuff);
} catch (err) {
  if (err instanceof RunFailedError) {
    const report = err.error; // RunErrorReport | null
    console.error(err.message); // "Run finished with status FAILED: <the report's message>"
    if (report?.user_action) console.error(`Next step: ${report.user_action.detail}`);
    if (report?.retryable) console.error("A retry can succeed.");
    console.error(`Run id for support: ${err.runId}`);
  } else if (err instanceof ApiResponseError) {
    // A refused request — or, against a bare runner, a run that failed on the blocking path.
    console.error(err.serverMessage, err.userAction?.detail, `request id ${err.requestId}`);
  } else {
    throw err;
  }
}
```

The report's fields, all optional because the runner owns the shape:

| Field | Meaning |
|---|---|
| `message` | What went wrong, as the runner wrote it. For a run failure it is where the failing pipe is named. |
| `error_domain` | Who can fix it: `input` (the caller — a malformed method, a bad input), `config` (a configuration change — a model the backend does not serve, a missing secret), `runtime` (nobody beforehand — a provider outage). **A branch field.** |
| `type_uri` | The stable URI naming the error class, the same on every occurrence. **A branch field.** |
| `retryable` | Whether running it again can succeed. Absent means unknown, which is not `false`. **A branch field.** |
| `user_action` | The next step, as `{ kind, detail }`: `detail` is the advice in words, `kind` its category (`wait_and_retry`, `check_billing`, `check_credentials`, `change_input`, `change_model`, `contact_support`, `unknown`). |
| `title` | The stable human label of the error class. |
| `error_type` | The runner's exception class name — an open set, for display and support, never matched against. |
| `error_category` | The finer class of an inference failure: `transient`, `configuration`, `content`, `capacity`, `ambiguous`, `unknown`. |
| `model`, `provider` | The model and provider an inference failure involved. |
| `provider_metadata` | What the provider's SDK said: `provider`, `sdk_exception_type`, `message`, `status_code`, `request_id` (the provider's own), `retry_after_seconds`, `provider_error_code`. |
| `validation_errors` | The structured diagnostics of a method that failed validation, the same [items](#a-validation-item--validationerroritem) the validate report carries. |
| `migration` | A pending configuration migration that explains the failure, present only when the runner's scan found one. |
| `caller_facing_message` | `true` when `message` was written as caller-facing copy. |

A field a newer runner adds is reachable through the interface's index signature before this SDK names it.

**The report is `null` when the run has none.** A run the platform finalized itself carries no report: one whose start failed, and a timeout, a termination or a vanished workflow resolved by the platform. A cancelled run usually has none either. The status and the `detail` sentence still say what happened, and the absence of a report says nothing about why.

**Nothing is stripped, so presentation is yours.** The platform serves the runner's VERBOSE report, so `message` and `provider_metadata.message` can hold a provider's raw text. The SDK types what the platform sends; deciding what a person sees is the consumer's decision. `RunFailedError.message`, being the `detail`, already contains the report's message.

**Numbers in `provider_metadata` may arrive as strings.** A report read back from the platform's run store carries `status_code` and `retry_after_seconds` as strings (`"404"`, `"1.5"`), because the store returns its numbers as decimals that the platform serializes as strings; a problem document a runner renders carries them as numbers. Both are in the type, so read them with `Number(...)`.

## A refused request — `ApiResponseError`

Every non-2xx answer from a `/v1` route is a problem document, and the SDK throws an `ApiResponseError` whose fields are its members. Each field is `undefined` when the document did not carry it, and a member of the wrong type (a numeric `type`, a `retryable` of `"no"`, a `user_action` without a `detail`) reads as absent rather than as a wrong value.

| Field | Wire member | Meaning |
|---|---|---|
| `errorDomain` | `error_domain` | Who can fix it: `input`, `config` or `runtime`. **A branch field.** |
| `type` | `type` | The stable URI naming the error class. **A branch field.** |
| `retryable` | `retryable` | Whether retrying the same request can succeed; `undefined` means unknown. |
| `userAction` | `user_action` | The next step, `{ kind, detail }`. |
| `requestId` | `request_id`, else the `X-Request-ID` header | The id to hand to support: it finds the server's log lines for the request. |
| `title` | `title` | The stable human label of the error class. |
| `serverMessage` | `detail` (or `message`) | The per-occurrence message. |
| `instance` | `instance` | The occurrence: a request URN (`urn:pipelex:request:<id>`) or a request path. |
| `code` | `code` | The platform's native code, a closed set (`conflict`, `not_found`, `validation_failed`, `pipelex_api_key_limit_reached`, …), one-to-one with `type`. |
| `errorType` | `error_type` | The runner's native code, its open exception class name. |
| `errorCategory`, `model`, `provider`, `providerMetadata` | `error_category`, `model`, `provider`, `provider_metadata` | An inference failure's class and origin, as on the run report. |
| `migration` | `migration` | A pending configuration migration that explains the failure. |
| `validationErrors` | `validation_errors` | The structured diagnostics of a bundle that failed validation, as [validation items](#a-validation-item--validationerroritem). |
| `errors` | `errors` | The platform's field-level failures, `{ field, code, detail }` each. |
| `problemDocument` | the whole body | The decoded document, every member named or not; `undefined` when the body was not a JSON object. |
| `status`, `statusText`, `responseBody` | the transport | The HTTP status, its text and the raw body. |

**Branch on `errorDomain` and `type`, never on the HTTP status or the message.** That is the rule the hosted-envelope spec sets for every surface: `errorDomain` tells the caller's own mistake from a fault it cannot fix, and `type` names the error class with a URI that stays the same on every occurrence. `code` and `errorType` are each surface's finer native code, and stay available for logs and support. On the platform today `errorDomain` is not emitted yet, and `type` is `https://pipelex.com/errors/<code>`, so branching on `type` there is branching on the code:

```ts
import { ApiResponseError } from "@pipelex/sdk";

try {
  await client.createPipelexApiKey({ label: "ci" });
} catch (err) {
  if (!(err instanceof ApiResponseError)) throw err;
  if (err.type === "https://pipelex.com/errors/pipelex_api_key_limit_reached") {
    // revoke a key first
  } else if (err.errorDomain === "input") {
    console.error(err.serverMessage, err.userAction?.detail, err.errors);
  } else {
    console.error(`${err.serverMessage} (request id ${err.requestId ?? "unknown"})`);
  }
}
```

The members `mthds`'s own `ApiResponseError` carries (`type`, `title`, `instance`, `requestId`, `errorDomain`, `retryable`, `userAction`) have the same names and types here, and a type-level test pins them to the standard client's declarations, so a consumer reads one vocabulary whichever client raised the error. The rest are the Pipelex members the standard's client leaves to this SDK.

## A validation item — `ValidationErrorItem`

A method refused for what it says, rather than for how its run went, comes back as a list of validation items. They ride the `/v1/validate` verdict's `validation_errors[]` (a `200`, since an invalid bundle is a produced verdict), a refused run's or build's `ApiResponseError.validationErrors` (a `422`), and a failed run's report as `validation_errors`. Each item has a `category` and a `message`; the other members locate the error and say what to do next, and each is present only when the runner knows it:

| Member | Meaning |
|---|---|
| `category` | The stage that found the error: `blueprint_validation`, `pipe_factory`, `pipe_validation` or `dry_run`. |
| `message` | What is wrong, in words. |
| `error_type` | The error's code, such as `unknown_model`. |
| `pipe_code`, `concept_code`, `domain_code` | The pipe, concept and domain the error is in. |
| `source`, `field_path`, `field_name` | The file the error is in (the name passed in `mthds_sources`), and the field, as a path such as `pipe.summarize.model` and by name. |
| `missing_concept_code`, `missing_pipe_code`, `declared_concepts` | The concept or pipe a reference names that the bundle does not declare, and the concepts the domain does declare. |
| `variable_names` | The input variables an input error concerns. |
| `model_reference`, `model_type`, `suggestions` | On an `unknown_model` item: the model reference exactly as the author wrote it, the kind of model the field takes (`llm`, `img_gen`, …), and the close matches, each spelled as a reference the field accepts. |
| `suggested_fix` | The runner's deterministic correction, when it has one: a `description` in words, `ops` that patch the `.mthds` document by table and key rather than by text, `safety` (`safe` to apply without asking, or `unsafe`) and the `source` file the ops apply to. An unknown model with exactly one close match carries a `rename-model` fix that remaps the reference to it. |

```ts
const report = await client.validate(contents, false, sources);
if (!report.is_valid) {
  for (const item of report.validation_errors) {
    console.error(`${item.source ?? "?"} ${item.pipe_code ?? ""}: ${item.message}`);
    if (item.suggestions?.length) console.error(`Did you mean: ${item.suggestions.join(", ")}`);
    if (item.suggested_fix) console.error(`Fix: ${item.suggested_fix.description}`);
  }
}
```

**The shape is `mthds`'s.** The standard's client declares the same item and the same fix vocabulary (`SuggestedFix`, `FixOp` and its arms, `FixSafety`, `FixOpKind`, `FixValue`), member for member under the same names, and this SDK exports every one of those names, so a consumer reads one vocabulary whichever client handed it the item. `@pipelex/sdk` imports `mthds` only through `mthds/protocol`, and `mthds` exports these declarations from its package root, so they are restated in `src/models.ts` and a type-level test pins them to the standard's: a member added on one side and not the other fails `make check`.

**An unset member can be `null`.** That is the one way this declaration differs from the standard's. The verdict's valid arm, which carries the advisory `warnings[]`, sends an unset member as an explicit `null`, where every other channel leaves the key out, so every optional member is typed `| null`. Read a member with a truthiness check or `??`, never with `=== undefined`.

# Run usage — reading what a run consumed

A completed run reports what its inference calls consumed as a list of `TokensUsageRecord` objects on `RunResults`, one per inference call, in the order the calls completed. This page covers how to read them, what each field means, the edge cases the type is deliberately shaped around, and `summarizeUsage`, which folds them into one run-level summary under those rules.

The wire shape is not this SDK's invention: it is specified in Pipelex's protocol spec, under "TokensUsage records on run artifacts", and the `TokensUsageRecord` interface in `src/runs.ts` is a client-side mirror of it. `pipelex-sdk` (Python) carries the same mirror. The record is a Pipelex runtime concept rather than part of the MTHDS standard — the MTHDS protocol itself says nothing about usage reporting.

## Reading the records

```ts
const result = await client.startAndWaitForResult({
  pipe_code: "my_domain.summarize",
  inputs: { text: "..." },
});

if (result.tokens_usages) {
  for (const record of result.tokens_usages) {
    console.log(record.pipe_code, record.inference_model_name, record.nb_tokens_by_category, record.cost);
  }
}
```

For the run's totals, do not add the records up by hand: [`summarizeUsage`](#summarizing-a-run--summarizeusage) does it under the rules below.

The accessor is the same whichever path ran. `startAndWaitForResult` picks a path from the `GET /v1/version` handshake:

- **Hosted (durable) path** — the records come from the runner's `tokens_usages.json` artifact, which `GET /v1/runs/{id}/results` unpacks onto the results body as top-level keys and relays verbatim.
- **Bare runner (blocking) path** — the records ride the execute response's extension-open `pipe_output` as Pipelex extension fields; the SDK lifts them onto the same two top-level fields.

Because the runtime emits both surfaces through one helper, the two cannot structurally diverge.

## Field reference

| field | type | meaning |
|---|---|---|
| `model_type` | `string \| null` | Kind of inference. Known values: `llm`, `img_gen`, `extract`, `search`. |
| `inference_model_name` | `string \| null` | Human model name (e.g. `gpt-4o`). |
| `inference_model_id` | `string \| null` | Provider/platform model id (e.g. `gpt-4o-2024-11-20`). |
| `pipe_code` | `string \| null` | The pipe that made the call — what makes per-pipe cost attribution possible. |
| `job_category` | `string \| null` | Known values: `llm_job`, `img_gen_job`, `extract_job`, `search_job`, `jinja2_job`, `mock_job`. |
| `unit_job_id` | `string \| null` | Known values: `llm_gen_text`, `llm_gen_object`, `img_gen_text_to_image`, `extract_pages`, `search_sourced_answer`, `search_structured`. |
| `nb_tokens_by_category` | `Record<string, number> \| null` | Raw provider-reported token counts, keyed by token category (`input`, `input_cached`, `output`, `output_reasoning`, …). |
| `cost` | `number \| null` | Computed USD cost of this call. |
| `started_at` | `string \| null` | ISO 8601. |
| `completed_at` | `string \| null` | ISO 8601. |

Two traps worth naming explicitly:

- **Token categories are not additive.** `input` is the joined total and `input_cached` is a *subset* of it. Summing every category double-counts the cached tokens.
- **Duration is not shipped.** Derive it from the `started_at` / `completed_at` pair.

### Enum-ish fields are open sets

`model_type`, `job_category`, `unit_job_id`, and the `nb_tokens_by_category` keys are plain `string`, never frozen union types, and the values listed above are *known* values rather than an exhaustive set. This is deliberate: the runtime can add an inference kind without breaking any SDK consumer. Switch on them defensively — do not assume the list is closed.

## Cost semantics

`cost` is a server-computed USD total for that one call. The rate table behind it is not a contract field and does not cross the wire, so there is nothing to recompute client-side and no risk of a client's arithmetic disagreeing with the runtime's own reporting — the figure comes from the same cost engine that produces the local CLI cost table. (Pre-contract artifacts are the one exception: they carry a raw `unit_costs` table, which is a relic rather than an API — see [Old artifacts type-check too](#old-artifacts-type-check-too).)

- `cost === null` means the model has **no rate table at all** — an own-GPU model, a mock run, a dry run.
- `cost === 0` means a rate table existed and priced the call at zero.

Those are different facts; `record.cost ?? 0` conflates them, which is fine for a sum but wrong for "was this call priced?".

There is no per-category cost breakdown and no run-level aggregate on the wire. The run total is the sum of the records, and [`summarizeUsage`](#summarizing-a-run--summarizeusage) computes it with the `null` / `0` distinction kept.

## Null and empty semantics

`tokens_usages` is null whenever usage assembly produced no list at all, which happens for three different reasons:

- usage assembly was **off** for the run;
- usage assembly **broke** (an event-read failure);
- on the hosted path, the run was **delivered before the artifact existed**.

It is `[]` when assembly ran, succeeded, and no inference happened, and non-empty otherwise. An empty list is a run that did no inference, so the run's total cost is `0` and its token totals are zero, never `null`: `null` stays reserved for calls that were not rated.

`usage_assembly_error` is the **only** field that distinguishes the broken case from the other two — they are otherwise indistinguishable on the wire. A caller that needs to tell "we have no usage data because something failed" from "there was nothing to report" must branch on `usage_assembly_error`, not on `tokens_usages` alone:

```ts
if (result.usage_assembly_error != null) {
  console.warn("usage assembly failed for this run:", result.usage_assembly_error);
} else if (result.tokens_usages == null) {
  // usage was off, or this run predates the artifact
} else if (result.tokens_usages.length === 0) {
  // ran, but no inference happened
}
```

## Summarizing a run — `summarizeUsage`

`summarizeUsage(results)` folds a run's usage pair into one run-level reading and a per-pipe rollup, applying every rule on this page so that no consumer has to re-derive them. It is pure: it does no I/O, needs no client, and leaves its input untouched. It takes the whole `RunResults`, or any object carrying the `tokens_usages` / `usage_assembly_error` pair.

```ts
import { summarizeUsage } from "@pipelex/sdk";

const usage = summarizeUsage(result);

switch (usage.state) {
  case "records": {
    const cost = usage.total_cost_usd === null ? "not rated" : `$${usage.total_cost_usd.toFixed(4)}`;
    console.log(`${usage.calls} calls, ${cost}${usage.cost_partial ? " (partial)" : ""}`);
    for (const pipe of usage.by_pipe) {
      console.log(pipe.pipe_code ?? "(unattributed)", pipe.total_cost_usd, pipe.calls);
    }
    break;
  }
  case "no_inference":
    console.log("no inference happened: $0");
    break;
  case "unavailable":
    console.log(usage.assembly_error ?? "usage was not reported for this run");
    break;
}
```

| field | type | meaning |
|---|---|---|
| `state` | `"records" \| "no_inference" \| "unavailable"` | Which reading of `tokens_usages` the summary describes. Read it first. |
| `total_cost_usd` | `number \| null` | Sum of the priced calls' costs, in USD. |
| `cost_partial` | `boolean` | True when priced and unrated calls are mixed, so the total covers the priced calls only and is a lower bound. |
| `tokens` | `{ input: number \| null; output: number \| null }` | The two additive token totals, each summed over the records that reported it. A category no record reported is `null`, which is different from a reported `0`. |
| `calls` | `number` | Number of records summarized, one per inference call. |
| `assembly_error` | `string \| null` | `usage_assembly_error` as relayed. |
| `by_pipe` | `PipeUsageSummary[]` | One row per `pipe_code`, each carrying `pipe_code`, `total_cost_usd`, `cost_partial`, `tokens` and `calls`, folded over that pipe's calls exactly as the run level is. |

The three states follow the [null and empty semantics](#null-and-empty-semantics) above:

| `state` | `tokens_usages` | `total_cost_usd` | `tokens` | `calls` | `by_pipe` |
|---|---|---|---|---|---|
| `records` | a non-empty list | the priced sum, or `null` when no call was priced | the summed totals | the record count | one row per pipe |
| `no_inference` | `[]` | `0` | `{ input: 0, output: 0 }` | `0` | `[]` |
| `unavailable` | `null` or absent | `null` | `{ input: null, output: null }` | `0` | `[]` |

A `null` `total_cost_usd` therefore means one of two things, and `state` tells them apart: under `records` no call was rated, and under `unavailable` nothing is known. Within `unavailable`, `assembly_error` is still the only sign that usage assembly broke rather than being off or not yet written.

`by_pipe` puts the most expensive pipe first. Priced pipes come by cost, descending, and unrated pipes after every priced one; a tie breaks on the call count, descending, and then on the pipe code. The calls the runtime did not attribute to a pipe (`pipe_code: null`) form one group of their own, which sorts after the named pipes when everything else ties.

A [pre-contract record](#old-artifacts-type-check-too) carries no `cost` and no `pipe_code`, so it counts as unrated and unattributed. Its legacy `job_metadata` and `unit_costs` are never read, so an old artifact shows up as a partial or `null` total rather than as a figure the SDK guessed.

## Old artifacts type-check too

Durable artifacts written before this contract shipped are relayed verbatim and never migrated. `TokensUsageRecord` therefore keeps **every field optional** and carries an index signature (`[extension: string]: unknown`) — a pre-contract record is a valid value:

- `cost` arrives absent (it did not exist yet — the record carried a raw `unit_costs` rate table instead);
- `pipe_code` arrives absent (it was still nested inside a `job_metadata` object rather than flattened onto the record);
- the legacy `job_metadata` and `unit_costs` stay reachable through the index signature.

Those legacy fields are **not** contract fields. They exist on old records only, and reading them is reading a relic — a record the current runtime emits never carries them. Treat their presence as a signal that you are looking at an old artifact, not as an API.

Conversely, a record the current runtime emits always carries the **full key set**: a field with no value is an explicit `null`, never an omitted key. You can read any field without an existence check — though TypeScript will still narrow the optional types, so keep the null handling.

## What is deliberately absent

The runtime's internal reporting models carry execution plumbing — `job_metadata`, `otel_context`, `trace_context`, `session_id`, `request_id`, `user_id`, `pipe_run_id`, `content_generation_job_id` — that is dropped at the boundary: on a record emitted under this contract, finding one of these is reading a leak, not a contract field. This is enforced upstream by leak-regression tests in `pipelex` and a conformance leak guard that walks relayed records at any nesting depth. Pre-contract artifacts are the documented exemption — relayed verbatim, they legitimately still carry `job_metadata` and `unit_costs`, and the leak guard does not run on them.

One consequence worth knowing: the record shape is **invariant** with respect to server-side telemetry and tracing settings, because the only fields that varied with them are precisely the ones the boundary drops. You never get a structurally different record because an operator changed an observability setting.

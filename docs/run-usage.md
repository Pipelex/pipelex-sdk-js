# Run usage — reading what a run consumed

A completed run reports what its inference calls consumed as a list of `TokensUsageRecord` objects on `RunResults`, one per inference call, in the order the calls completed. This page covers how to read them, what each field means, and the edge cases the type is deliberately shaped around.

The wire shape is not this SDK's invention: it is specified in the MTHDS protocol spec under [TokensUsage records on run artifacts](https://github.com/Pipelex/Pipelex/blob/main/docs/specs/pipelex-mthds-protocol.md#tokensusage-records-on-run-artifacts), and the `TokensUsageRecord` interface in `src/runs.ts` is a client-side mirror of it. `pipelex-sdk` (Python) carries the same mirror.

## Reading the records

```ts
const result = await client.startAndWaitForResult({ pipe_code: "my_domain.summarize", mthds_contents: [...] });

if (result.tokens_usages) {
  const totalCost = result.tokens_usages.reduce((sum, record) => sum + (record.cost ?? 0), 0);
  for (const record of result.tokens_usages) {
    console.log(record.pipe_code, record.inference_model_name, record.nb_tokens_by_category, record.cost);
  }
}
```

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

`cost` is a server-computed USD total for that one call. The underlying rate table never crosses the wire, so there is nothing to recompute client-side and no risk of a client's arithmetic disagreeing with the runtime's own reporting — the figure comes from the same cost engine that produces the local CLI cost table.

- `cost === null` means the model has **no rate table at all** — an own-GPU model, a mock run, a dry run.
- `cost === 0` means a rate table existed and priced the call at zero.

Those are different facts; `record.cost ?? 0` conflates them, which is fine for a sum but wrong for "was this call priced?".

There is no per-category cost breakdown and no run-level aggregate on the wire. Sum the records for a run total.

## Null and empty semantics

`tokens_usages` is null whenever usage assembly produced no list at all, which happens for three different reasons:

- usage assembly was **off** for the run;
- usage assembly **broke** (an event-read failure);
- on the hosted path, the run was **delivered before the artifact existed**.

It is `[]` when assembly ran, succeeded, and no inference happened, and non-empty otherwise.

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

## Old artifacts type-check too

Durable artifacts written before this contract shipped are relayed verbatim and never migrated. `TokensUsageRecord` therefore keeps **every field optional** and carries an index signature (`[extension: string]: unknown`) — a pre-contract record is a valid value:

- `cost` arrives absent (it did not exist yet — the record carried a raw `unit_costs` rate table instead);
- `pipe_code` arrives absent (it was still nested inside a `job_metadata` object rather than flattened onto the record);
- the legacy `job_metadata` and `unit_costs` stay reachable through the index signature.

Those legacy fields are **not** contract fields. They exist on old records only, and reading them is reading a relic — a record the current runtime emits never carries them. Treat their presence as a signal that you are looking at an old artifact, not as an API.

Conversely, a record the current runtime emits always carries the **full key set**: a field with no value is an explicit `null`, never an omitted key. You can read any field without an existence check — though TypeScript will still narrow the optional types, so keep the null handling.

## What is deliberately absent

The runtime's internal reporting models carry execution plumbing — `job_metadata`, `otel_context`, `trace_context`, `session_id`, `request_id`, `user_id`, `pipe_run_id`, `content_generation_job_id` — that is dropped at the boundary and must never appear on a record. This is enforced upstream by leak-regression tests in `pipelex` and a conformance leak guard that walks relayed records at any nesting depth.

One consequence worth knowing: the record shape is **invariant** with respect to server-side telemetry and tracing settings, because the only fields that varied with them are precisely the ones the boundary drops. You never get a structurally different record because an operator changed an observability setting.

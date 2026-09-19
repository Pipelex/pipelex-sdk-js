# Reading a run's results

A completed run hands back one object, `RunResults` (`src/runs.ts`), and every field of it is described here. The same object comes back from `startAndWaitForResult`, from `waitForResult(runId)`, and from the `completed` arm of `getRunResult(runId)` — one accessor set whichever path ran, which is the point of the type.

Two paths produce it. Against the hosted API the SDK starts a durable run and polls `GET /v1/runs/{id}/results`, where the platform relays the run's S3 artifacts verbatim. Against a bare `pipelex-api` runner, which has no run store, the SDK falls back to the blocking `POST /v1/execute` and maps the runner's native `pipe_output` onto the same shape, lifting the artifacts that ride it onto their own fields. `startAndWaitForResult` picks between the two from the `GET /v1/version` handshake, so a consumer does not choose.

| field | type | hosted (durable) path | bare-runner (blocking) path |
|---|---|---|---|
| `pipeline_run_id` | `string` | the run store's id | the runner's own id for the call |
| `main_stuff` | `unknown` | the `main_stuff.json` artifact | resolved out of the returned working memory |
| `graph_spec` | `unknown` | the `graphspec.json` artifact | lifted off `pipe_output` |
| `graph_assembly_error` | `string \| null \| undefined` | absent until the platform relays it | lifted off `pipe_output` |
| `tokens_usages` | `TokensUsageRecord[] \| null` | the `tokens_usages.json` artifact | lifted off `pipe_output` |
| `usage_assembly_error` | `string \| null` | relayed | lifted off `pipe_output` |
| `pipe_output` | `DictPipeOutput \| null \| undefined` | absent | the runner's whole native output |

## `pipeline_run_id` — the durable handle

The run id is what makes a run readable after the process that started it has gone. `start` returns it in its acknowledgement before the run finishes, and every lifecycle read takes it: `getRunStatus(runId)` for the status row, `getRunResult(runId)` for a single result lookup, `waitForResult(runId)` to resume polling a run an earlier session started. It is also what a `RunTimeoutError` leaves you with — the run keeps executing server-side, so the timeout is a reason to re-poll by id, not a reason to run the method again.

```ts
const ack = await client.start({ pipe_code: "my_domain.summarize", inputs: { text: "..." } });
console.log(ack.pipeline_run_id); // persist this — it outlives the process

// …later, in another process
const results = await client.waitForResult(ack.pipeline_run_id);
```

Against a bare runner the id identifies the call the runner just answered, but there is no run store behind it: the lifecycle routes are absent, so re-reading it raises `RunLifecycleUnavailableError`. Durable resumption is a hosted capability.

## `main_stuff` — the output

`main_stuff` is the resolved content of the run's main output and is always present for a completed run. On the hosted path it is the `main_stuff.json` artifact; on the blocking path the SDK resolves it out of the returned working memory through the response's `main_stuff_name`. Both deliver the same content shape, so there is no shape-guessing and no path-dependent branch to write. A completed run that cannot deliver one throws `MissingMainStuffError` rather than handing back a half-filled result.

It is typed `unknown` because the content is polymorphic — a structured output arrives as an object, a list output as a top-level array — and because it may legitimately be a falsy value such as `0` or `[]`. Narrow it where you read it, ideally through the types generated for the method rather than a hand-written cast.

```ts
const state = await client.getRunResult(runId);

switch (state.state) {
  case "completed": {
    // `state.result` is the RunResults; `main_stuff` is the output content.
    const summary = state.result.main_stuff as { title: string; bullets: string[] };
    console.log(summary.title, summary.bullets.length);
    break;
  }
  case "running":
    console.log(`not finished — poll again in ${state.retry_after_seconds ?? 2}s`);
    break;
  case "failed":
    console.error(`run ended as ${state.status}: ${state.message}`);
    break;
}
```

`getRunResult` is the single-shot lookup and returns that discriminated state. `waitForResult(runId)` drives the same lookup in a loop, honouring the server's `Retry-After`, and returns the `RunResults` directly — throwing `RunFailedError` on a terminal non-completed status and `RunTimeoutError` when the budget runs out.

## `graph_spec` — the executed graph

`graph_spec` is the graph the run actually executed: `mode: "live"`, one node per pipe with its execution status, its start and end timestamps, its inputs and outputs, and the inference models and cost attributed to it. It is the same document a local `pipelex` run writes as `graphspec.json`, so anything that reads one of those files reads this value unchanged.

The field is typed `unknown` by a standing ruling ([`architecture.md`](./architecture.md#standard-artifacts-on-the-validate-report)): the canonical declaration is `GraphSpec` in `@pipelex/mthds-ui`, which carries a React peer dependency that a server-side SDK has no business taking, and the MTHDS standard declares nothing this SDK could import instead. The value is relayed verbatim either way — the typing says where the schema lives, not that the content is uncertain.

**Rendering it.** `@pipelex/mthds-ui` ships the viewer that consumes it, and its `GraphSpec` type is the cast to use on the consumer side. The viewer must be loaded client-side only, because ReactFlow touches browser globals at module evaluation, so the import goes through `next/dynamic` with `ssr: false` rather than a static one. It also fills its parent, so that parent needs `position: relative` and a height of its own or the graph renders at zero height:

```tsx
"use client";

import dynamic from "next/dynamic";
import type { RunResults } from "@pipelex/sdk";
import type { GraphSpec } from "@pipelex/mthds-ui/graph";

const GraphViewer = dynamic(
  () => import("@pipelex/mthds-ui/graph/react").then((m) => m.GraphViewer),
  { ssr: false },
);

export function RunGraph({ results }: { results: RunResults }) {
  if (!results.graph_spec) return null;
  return (
    <div style={{ position: "relative", height: "600px" }}>
      <GraphViewer graphspec={results.graph_spec as GraphSpec} />
    </div>
  );
}
```

**Keeping it.** The value is plain JSON, so persisting it is a write; there is no SDK helper and none is needed. Keeping it is worth doing for anything you may have to explain later, because it is the only record of what the run did pipe by pipe:

```ts
import { writeFile } from "node:fs/promises";

await writeFile("graphspec.json", JSON.stringify(results.graph_spec, null, 2));
```

**When it is null.** On the hosted path, the artifact may not have been written when the results were delivered. On either path, the runner may have assembled no graph at all — which is what the next field is for.

## `graph_assembly_error` — why there is no graph

`graph_assembly_error` is the graph's twin of `usage_assembly_error`, and it exists for the same reason: a null `graph_spec` alone cannot say whether graph assembly was off, broke, or simply had not finished writing. When the runner's assembly failed, this field carries the runner's message.

On the blocking path the SDK lifts it off `pipe_output`, beside the graph itself. **On the hosted path the key is absent, so the field reads `undefined` rather than `null`**: the platform's results body relays no such key and the SDK parses that body as it arrives, so the failure the bare runner reports is not yet observable through the hosted API. The field is declared ahead of that relay so consumers have one accessor to write against and nothing breaks the day the wire gains the key — the value appears on its own, with no SDK change. Until then, treat `undefined` on the hosted path as "no information", not as "assembly succeeded", and compare with `!= null` rather than `=== null` so that the same branch keeps working once the key arrives.

```ts
if (results.graph_assembly_error != null) {
  console.warn("graph assembly failed for this run:", results.graph_assembly_error);
} else if (results.graph_spec == null) {
  // no graph: assembly was off, the artifact was not written, or (hosted) the error is not relayed
}
```

## `tokens_usages` and `usage_assembly_error` — what the run consumed

The usage pair reports what each inference call consumed and cost — one `TokensUsageRecord` per call, in completion order — and reads identically on both paths. The null-versus-empty semantics, the cost rules (`null` is unrated, `0` is priced at zero), the non-additive token categories and the pre-contract artifacts that still type-check all have their own page: [`run-usage.md`](./run-usage.md).

For the run's totals, call `summarizeUsage(results)` rather than adding the records up by hand: it returns the total cost, the input and output token totals and a per-pipe rollup, with a `state` that tells a run with records from one that did no inference and from one whose usage is unavailable. See [Summarizing a run](./run-usage.md#summarizing-a-run--summarizeusage).

## `pipe_output` — the runner's native output

`pipe_output` is the bare runner's whole native output, `{ root, aliases }` working memory included, and it is present on the blocking path only — the hosted results body carries no such key, so on that path it reads `undefined`. It is supplementary: `main_stuff`, the graph and the usage pair are already lifted out of it, so reading it is for consumers that want every named stuff of the run rather than the main output alone. It is typed `DictPipeOutput`, which is extension-open — the runner's Pipelex extension fields are reachable through the index signature without casting the whole value away.

## Produced files

A run that produces an image, a PDF or a document does not embed the bytes. The content inside `main_stuff` carries the file's durable reference — a `pipelex-storage://` URI, in the content's `url` — beside a `public_url` the storage provider signed when the run wrote the file. **That signed link is short-lived and must not be stored**: it expires on the provider's own schedule, so a link persisted in a database or rendered into a cached page stops working without warning, while the `pipelex-storage://` reference beside it is permanent and is what belongs in your records.

To read the bytes, mint a fresh link from the reference:

```ts
const resolved = await client.resolveStorageUrl({ uri: "pipelex-storage://..." });
// { url, expires_at, content_type } — fetch `url` now; re-resolve for the next reader.
```

The same rule holds in a browser: resolve on the server, hand the client a link it uses immediately, and never let a presigned URL outlive the request it was minted for. The upload direction — turning local files into `pipelex-storage://` references before a run — is the mirror of this and has its own page, [`input-preparation.md`](./input-preparation.md).

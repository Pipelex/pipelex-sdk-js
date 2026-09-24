# Reading a run's results

A completed run hands back one object, `RunResults` (`src/runs.ts`), and every field of it is described here. The same object comes back from `startAndWaitForResult`, from `waitForResult(runId)`, and from the `completed` arm of `getRunResult(runId)` — one accessor set whichever path ran, which is the point of the type.

Two paths produce it. Against the hosted API the SDK starts a durable run and polls `GET /v1/runs/{id}/results`, where the platform relays the run's S3 artifacts verbatim. Against a bare `pipelex-api` runner, which has no run store, the SDK falls back to the blocking `POST /v1/execute` and maps the runner's native `pipe_output` onto the same shape, lifting the artifacts that ride it onto their own fields. `startAndWaitForResult` picks between the two from the `GET /v1/version` handshake, so a consumer does not choose.

**Calling the blocking route yourself.** `execute()` returns a `PipelexExecuteResult` rather than a `RunResults`, because that object is the runner's whole typed envelope and nothing of it is thrown away. To read such a result through this page's fields, lift it: `resultsFromExecute(result)` (`src/execute-result.ts`) is the same mapping `startAndWaitForResult` applies on its fallback, exposed for the caller who drives `execute()` directly. It is pure — no client, no network — and what it buys is everything written against `RunResults`: `summarizeUsage`, `downloadArtifacts`, the graph pair and the three I/O artifacts, instead of re-reading `pipe_output` by hand.

```ts
import { resultsFromExecute, summarizeUsage } from "@pipelex/sdk";

const executeResult = await client.execute({ pipe_code: "my_domain.my_pipe", mthds_contents: [source] });
const results = resultsFromExecute(executeResult);
console.log(results.main_stuff, summarizeUsage(results).total_cost_usd);
```

| field | type | hosted (durable) path | bare-runner (blocking) path |
|---|---|---|---|
| `pipeline_run_id` | `string` | the run store's id | the runner's own id for the call |
| `main_stuff` | `unknown` | the `main_stuff.json` artifact | resolved out of the returned working memory |
| `working_memory` | `DictWorkingMemory \| null` | the `working_memory.json` artifact | lifted off `pipe_output` |
| `graph_spec` | `unknown` | the `graphspec.json` artifact | lifted off `pipe_output` |
| `graph_assembly_error` | `string \| null \| undefined` | absent until the platform relays it | lifted off `pipe_output` |
| `pipe_io_contracts` | `PipeIOContracts \| null \| undefined` | the `pipe_io_contracts.json` artifact, once relayed | lifted off `pipe_output` |
| `input_form` | `InputForm \| null \| undefined` | the `input_form.json` artifact, once relayed | lifted off `pipe_output` |
| `output_form` | `OutputForm \| null \| undefined` | the `output_form.json` artifact, once relayed | lifted off `pipe_output` |
| `pipe_io_artifacts_error` | `string \| null \| undefined` | absent until the platform relays it | lifted off `pipe_output` |
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

It is typed `unknown` because the content is polymorphic: a structured output arrives as an object of the concept's fields, and a multiple output as the envelope `{ items: [...] }` that the runtime's `ListContent` serialises to. Every content type serialises to an object, natives included — a text output is `{ "text": "…" }` and a number `{ "number": 0 }` — so a guard written for a bare `""` or `0` never fires, and an empty multiple output is `{ "items": [] }` rather than `[]`. Narrow it where you read it, ideally through the types generated for the method rather than a hand-written cast.

For a multiple output that means reading `items` off the object and mapping the generated per-concept parser over its members, because codegen emits a parser per concept and no wrapper type for the envelope. **Do not rely on the parser to catch the mistake for you.** The generated schemas are not strict, so a concept with a required field rejects the envelope loudly, while one whose fields are all optional parses it to `{}` and discards the output in silence.

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

## `working_memory` — every named stuff of the run

`working_memory` is the run's whole working memory: every named stuff the run held when it finished, as `{ root, aliases }`. `root` maps each stuff's name to the stuff itself — its concept ref, a string such as `native.Text`, and its content — and `aliases` maps further names onto root keys. It holds the inputs the run was given and the intermediates it produced as well as the main output, which is what a consumer needs to show what went into a run beside what came out, or to repopulate the inputs of a run it restores.

It reads the same on both paths. On the hosted path it is the `working_memory.json` artifact, relayed verbatim; on the blocking path the SDK lifts it off `pipe_output`. On the hosted path it is `null` when the artifact had not been written when the results were delivered. On the blocking path it is always there, because the SDK resolves `main_stuff` out of it and a response without one throws `MissingMainStuffError` first.

`main_stuff` is one of its entries — the content of the stuff the run names as its main output — already resolved. Read `main_stuff` for the output and `working_memory` for everything else; there is no need to find the main output in the working memory by hand. The type, `DictWorkingMemory`, mirrors the MTHDS standard's `DictWorkingMemory` field for field.

```ts
for (const [name, stuff] of Object.entries(results.working_memory?.root ?? {})) {
  console.log(name, stuff.concept); // e.g. "text native.Text"
}
```

**Older runs carry the concept as an object.** A runtime older than pipelex 0.60.0 wrote each stuff's `concept` as the full concept object rather than its ref string: every hosted run whose `working_memory.json` was written before the hosted plane moved to that release, and every run of a bare runner still pinned below it. The artifact is relayed as it was written and never migrated. The type deliberately stays the standard's `concept: string`, which is what every run from 0.60.0 on carries, rather than widening to describe relics — so a consumer listing runs that may predate the release reads `concept` as `unknown` and narrows it itself:

```ts
const concept: unknown = stuff.concept;
const ref = typeof concept === "string" ? concept : undefined; // undefined: a pre-0.60.0 concept object
```

## `graph_spec` — the executed graph

`graph_spec` is the graph the run actually executed: `meta.mode` is `"live"`, and there is one node per pipe with its execution status, its start and end timestamps, its inputs and outputs, and the inference models and cost attributed to it. It is the same document a local `pipelex` run writes as `graphspec.json`, so anything that reads one of those files reads this value unchanged.

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
      <GraphViewer
        graphspec={results.graph_spec as GraphSpec}
        // The I/O artifacts are what make a data node show its VALUE rather than the concept's
        // structure table. The viewer takes `contracts` and `outputForm` together or neither.
        contracts={results.pipe_io_contracts ?? undefined}
        outputForm={results.output_form ?? undefined}
        inputForm={results.input_form ?? undefined}
      />
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

## `pipe_io_contracts`, `input_form` and `output_form` — what the graph's data is

`graph_spec` carries the values a run produced; these three say what those values ARE. They are the validate report's own artifacts — the standard's `PipeIOContracts`, `InputForm` and `OutputForm`, imported from `mthds/protocol` rather than restated here, under the same ruling that governs them on the validate report ([`architecture.md`](./architecture.md#standard-artifacts-on-the-validate-report)) — built over the library the run actually executed against and keyed by namespaced `pipe_ref` (`domain.code`) over one shared key set. They are the same documents a local `pipelex` run writes beside its `graphspec.json` as `pipe_io_contracts.json`, `input_form.json` and `output_form.json`, so a consumer reads one thing whether the artifacts came from `/v1/validate`, from a results directory, or from a hosted run.

The contract names each pipe's inputs and its output — the concept, the multiplicity, the JSON Schema of the payload — and the two form descriptors say what each of those slots IS as a typed field, which is what a renderer needs to lay a value out without inspecting it.

**Read the contracts and the output form together.** `@pipelex/mthds-ui`'s `GraphViewer` gates a data node's value on holding both: given the pair it renders the payload, and given one or neither it falls back to the concept's structure table with no data tab. That is why they arrive as a set rather than one at a time. `input_form` is optional even then — it is what lets the method's own inputs show their values, since no pipe produced them and no output descriptor describes them.

```ts
const contracts = results.pipe_io_contracts;
const outputForm = results.output_form;
if (contracts && outputForm) {
  const summarize = contracts["my_domain.summarize"];
  console.log(summarize?.output.concept_ref); // e.g. "my_domain.Summary"
  console.log(outputForm["my_domain.summarize"]?.field.kind); // e.g. "object"
}
```

**When they are absent.** On the blocking path the SDK unwraps the runner's `pipe_io_artifacts` envelope — the runner carries the three together, since they share a key set and are built in one pass — onto these three fields, so each has one accessor whichever path ran. On the hosted path the platform does not relay the keys yet, so all three read `undefined` there today; they are declared ahead of that relay so consumers have one accessor to write against and nothing breaks the day the wire gains them. They read `null` when the run described no data at all — graph tracing off, or a runtime older than the artifacts. Compare with `!= null` rather than `=== null`, exactly as with the graph pair.

## `pipe_io_artifacts_error` — why there is no description

`pipe_io_artifacts_error` is the three artifacts' twin of `graph_assembly_error`, and it exists for the same reason: three null artifacts alone cannot say whether the run described no data or whether building the description broke. When the runner's build failed, this field carries its message. It is lifted off `pipe_output` on the blocking path and, like `graph_assembly_error`, the hosted results body relays no such key — so treat `undefined` there as "no information", not as "the build succeeded".

## `tokens_usages` and `usage_assembly_error` — what the run consumed

The usage pair reports what each inference call consumed and cost — one `TokensUsageRecord` per call, in completion order — and reads identically on both paths. The null-versus-empty semantics, the cost rules (`null` is unrated, `0` is priced at zero), the non-additive token categories and the pre-contract artifacts that still type-check all have their own page: [`run-usage.md`](./run-usage.md).

For the run's totals, call `summarizeUsage(results)` rather than adding the records up by hand: it returns the total cost, the input and output token totals and a per-pipe rollup, with a `state` that tells a run with records from one that did no inference and from one whose usage is unavailable. See [Summarizing a run](./run-usage.md#summarizing-a-run--summarizeusage).

## `pipe_output` — the runner's native output

`pipe_output` is the bare runner's whole native output, and it is present on the blocking path only — the hosted results body carries no such key, so on that path it reads `undefined`. It is supplementary: `main_stuff`, `working_memory`, the graph and the usage pair are all lifted out of it onto fields that read the same on both paths, so a consumer that wants every named stuff of the run reads `working_memory`, not `pipe_output.working_memory`, and its code keeps working against the hosted API. What `pipe_output` adds is the runner's output exactly as it arrived. It is typed `DictPipeOutput`, which is extension-open — the runner's Pipelex extension fields are reachable through the index signature without casting the whole value away. A caller holding an `execute()` result rather than a `RunResults` does that lift with `resultsFromExecute`, described at the top of this page, instead of reading the extension fields itself.

## Produced files

A run that produces an image, a PDF or a document does not embed the bytes. The content inside `main_stuff` carries the file's durable reference — a `pipelex-storage://` URI, in the content's `url` — beside a `public_url` the storage provider signed when the run wrote the file. **That signed link is short-lived and must not be stored**: it expires on the provider's own schedule, so a link persisted in a database or rendered into a cached page stops working without warning, while the `pipelex-storage://` reference beside it is permanent and is what belongs in your records.

To read the bytes, mint a fresh link from the reference:

```ts
const resolved = await client.resolveStorageUrl({ uri: "pipelex-storage://..." });
// { url, expires_at, content_type } — fetch `url` now; re-resolve for the next reader.
```

The same rule holds in a browser: resolve on the server, hand the client a link it uses immediately, and never let a presigned URL outlive the request it was minted for.

Bringing the files down is the SDK's job, not something to re-implement over `resolveStorageUrl`: `locateArtifacts` lists a result's references without touching the network, each with the paths of the fields it fills (`collectArtifacts` gives the references alone), `resolveArtifacts` mints fresh links for a whole list in one bulk call, `fetchArtifact` streams one file within safe bounds, and `downloadArtifacts` saves everything a run produced under a directory, each file named after the field it fills, by run id even days later. They all share one page, [`artifact-download.md`](./artifact-download.md). The upload direction — turning local files into `pipelex-storage://` references before a run — is the mirror of this and has its own page too, [`input-preparation.md`](./input-preparation.md).

# @pipelex/sdk

TypeScript SDK for the **Pipelex hosted API** — execute MTHDS methods, manage runs, and call the product surface (methods catalog, organizations, billing, API keys, storage) from Node.

> Pipelex is the runtime/product. [MTHDS](https://mthds.ai) is the open standard it implements. This SDK speaks to the hosted Pipelex API; the pure protocol wire types it builds on come from the [`mthds`](https://www.npmjs.com/package/mthds) package via its `mthds/protocol` subpath.

## Status

Early. `PipelexApiClient` implements the MTHDS protocol-execution routes (`execute` / `start` / `validate` / `models` / `version`), the build helpers (`/v1/build/*`), the crate routes (`resolve` / `codegen`), the durable run lifecycle (`start` → poll → result), and the Pipelex product routes (user profile, methods catalog, organizations, billing, API keys, onboarding, storage, runs list/update).

Besides the client, the package exports `runCodegenCheck` — a **pure** offline check that verifies a committed `codegen()` tree still matches its `codegen.lock`. It needs no server, no key, and no client instance, so it fits a CI job. See [`docs/crate-routes.md`](./docs/crate-routes.md#the-offline-check--runcodegencheck).

It also exports `summarizeUsage`, which folds a completed run's usage records into one null-aware summary — total cost, input and output tokens, and a per-pipe rollup — without any I/O. See [`docs/run-usage.md`](./docs/run-usage.md#summarizing-a-run--summarizeusage).

## Install

```bash
npm install @pipelex/sdk
```

## Usage

```ts
import { PipelexApiClient } from "@pipelex/sdk";

// Base URL + key from PIPELEX_BASE_URL / PIPELEX_API_KEY, or pass them explicitly.
const client = new PipelexApiClient({
  baseUrl: "https://api.pipelex.com",
  apiKey: process.env.PIPELEX_API_KEY,
});

// Validate an MTHDS bundle (a 200-diagnostic verdict, discriminated on `is_valid`).
const report = await client.validate(["domain = 'demo'"]);
if (report.is_valid) {
  // Run it and wait for the result (durable start + poll on the hosted API).
  const result = await client.startAndWaitForResult({ pipe_code: "demo.greet" });
  // Every completed run delivers a resolved `main_stuff`, and every named stuff of
  // the run in `working_memory`.
  console.log(result.main_stuff);
}

// Or run a published method by address — resolved server-side (fetch at tag,
// commit SHA recorded as provenance on the start ack). Requires pipelex-api >= 0.21.0;
// on api.pipelex.com, availability follows the platform deploy that forwards it.
const ack = await client.start({
  method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
  inputs: { document: { url: "https://example.com/report.pdf" } },
});
console.log(ack.method_provenance); // { address, tag, commit_sha }
```

### Product routes

The hosted management surface (catalog, account, billing) hangs off the same client. Every product route maps a non-2xx `problem+json` to a typed `ApiResponseError` — branch on the structured `code`, not the HTTP status:

```ts
import { PipelexApiClient, ApiResponseError } from "@pipelex/sdk";

const client = new PipelexApiClient({ apiKey: process.env.PIPELEX_API_KEY });

const me = await client.getMe(); // GET /v1/me
const page = await client.listMethods(); // GET /v1/methods — one page: { items, nextCursor }
for await (const method of client.iterateMethods()) {
  // follows the cursor for callers that genuinely want the whole catalog
}
const created = await client.createMethod({ name: "Greeter", mthds: "domain = 'demo'" });

try {
  const { portal_url } = await client.getBillingPortal();
  // open portal_url ...
} catch (err) {
  if (err instanceof ApiResponseError && err.code === "conflict") {
    // no subscription yet — start one via createCheckout(...)
  }
}
```

### Client identification

Every request to the API carries a `User-Agent` such as `pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)`, which the hosted platform reads to attribute traffic to a client surface in its analytics. A program built on the SDK can put its own name in front with `appInfo`, shaped like Stripe's option of that name; an invalid field is refused at construction with a `TypeError`. In a browser the SDK sets no `User-Agent`. The convention is the workspace spec `docs/specs/client-identification.md`, and [`docs/client-identification.md`](./docs/client-identification.md) describes this SDK's side of it.

```ts
const client = new PipelexApiClient({ appInfo: { name: "acme-invoicer", version: "1.4.0" } });
// User-Agent: acme-invoicer/1.4.0 pipelex-sdk-js/<version> node/<version> (<os>; <arch>)
```

### Uploading from a browser

A browser page that holds a file but not the API key can still store it: the server that holds the key asks for an upload grant, and the page sends the file straight to storage with it. The file never crosses your server or the API gateway, so it can be as large as the service's own limit. The page imports `@pipelex/sdk/upload`, the browser-safe entry, which bundles with no Node builtin to mark external; the main `@pipelex/sdk` entry is Node-first.

```ts
// On the server, which holds the key:
const grant = await client.requestUploadGrant({
  filename: "report.pdf",
  content_type: "application/pdf",
  size: 48213,
});

// In the page, which holds the file:
import { uploadWithGrant } from "@pipelex/sdk/upload";
const { uri } = await uploadWithGrant(grant, file); // pipelex-storage://…
```

The full client surface is documented in [`docs/architecture.md`](./docs/architecture.md).

## Documentation

These pages ship inside the published package, so a reader who has only installed it opens them under `node_modules/@pipelex/sdk/docs/` — at the version being called, rather than whatever the repository's default branch says today. They are also browsable at [`Pipelex/pipelex-sdk-js/tree/main/docs`](https://github.com/Pipelex/pipelex-sdk-js/tree/main/docs), which is the address to give someone who has not installed the package.

| Page | What it covers |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | The whole client surface: the request pipeline, every route, the typed errors |
| [`docs/run-results.md`](./docs/run-results.md) | Every field of `RunResults` — the run id as a durable handle, `main_stuff`, `working_memory`, `graph_spec`, the usage pair, produced files |
| [`docs/run-usage.md`](./docs/run-usage.md) | What a run consumed, record by record, and `summarizeUsage` which folds them into one reading |
| [`docs/artifact-download.md`](./docs/artifact-download.md) | Turning the `pipelex-storage://` references a run produced back into bytes: `locateArtifacts`, `collectArtifacts`, `resolveArtifacts`, `fetchArtifact`, `downloadArtifacts`, and how a saved file is named after the field it fills |
| [`docs/input-preparation.md`](./docs/input-preparation.md) | The other direction — `uploadFile` and `prepareInputs`, which turn local files into references a run can take, and the upload grant a browser page sends a file with |
| [`docs/crate-routes.md`](./docs/crate-routes.md) | `resolve` and `codegen`, and the offline `runCodegenCheck` that guards a committed tree |
| [`docs/build-routes.md`](./docs/build-routes.md) | The `/v1/build/*` projections: `buildInputs`, `buildOutput`, `buildRunner` |
| [`docs/client-identification.md`](./docs/client-identification.md) | The `User-Agent` every API request carries, and `appInfo`, the option that puts your program's name in front of it |

## Develop

```bash
make install    # Install dependencies
make check      # Lint + format check + typecheck + build + depcruise (alias: make c)
make test       # Run the test suite (alias: make t)
make all        # Clean, check, and test
```

Always run `make check` before committing.

## License

[MIT](./LICENSE)

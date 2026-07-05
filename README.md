# @pipelex/sdk

TypeScript SDK for the **Pipelex hosted API** — execute MTHDS methods, manage runs, and call the product surface (methods catalog, organizations, billing, API keys, storage) from Node.

> Pipelex is the runtime/product. [MTHDS](https://mthds.ai) is the open standard it implements. This SDK speaks to the hosted Pipelex API; the pure protocol wire types it builds on come from the [`mthds`](https://www.npmjs.com/package/mthds) package via its `mthds/protocol` subpath.

## Status

Early. `PipelexApiClient` implements the MTHDS protocol-execution routes (`execute` / `start` / `validate` / `models` / `version`), the build helpers (`/v1/build/*`), the durable run lifecycle (`start` → poll → result), and the Pipelex product routes (user profile, methods catalog, organizations, billing, API keys, gateway key, onboarding, storage, runs list/update).

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
  // Every completed run delivers a resolved `main_stuff` (the full working memory
  // also rides `pipe_output` on the blocking path).
  console.log(result.main_stuff);
}
```

### Product routes

The hosted management surface (catalog, account, billing) hangs off the same client. Every product route maps a non-2xx `problem+json` to a typed `ApiResponseError` — branch on the structured `code`, not the HTTP status:

```ts
import { PipelexApiClient, ApiResponseError } from "@pipelex/sdk";

const client = new PipelexApiClient({ apiKey: process.env.PIPELEX_API_KEY });

const me = await client.getMe(); // GET /v1/me
const methods = await client.listMethods(); // GET /v1/methods
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

The full client surface is documented in [`docs/architecture.md`](./docs/architecture.md).

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

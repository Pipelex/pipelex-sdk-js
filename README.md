# @pipelex/sdk

TypeScript SDK for the **Pipelex hosted API** — execute MTHDS methods, manage runs, and call the product surface (methods catalog, organizations, billing, API keys, storage) from Node.

> Pipelex is the runtime/product. [MTHDS](https://mthds.ai) is the open standard it implements. This SDK speaks to the hosted Pipelex API; the pure protocol wire types it builds on come from the [`mthds`](https://www.npmjs.com/package/mthds) package via its `mthds/protocol` subpath.

## Status

Early. `PipelexApiClient` implements the MTHDS protocol-execution routes (`execute` / `start` / `validate` / `models` / `version`), the build helpers (`/v1/build/*`), and the durable run lifecycle (`start` → poll → result). The Pipelex product routes (methods catalog, organizations, billing, API keys, storage, onboarding) land next.

## Install

```bash
npm install @pipelex/sdk
```

## Usage

```ts
import { PipelexApiClient } from "@pipelex/sdk";

// Base URL + token from PIPELEX_API_URL / PIPELEX_API_KEY, or pass them explicitly.
const client = new PipelexApiClient({
  baseUrl: "https://api.pipelex.com",
  apiToken: process.env.PIPELEX_API_KEY,
});

// Validate an MTHDS bundle (a 200-diagnostic verdict, discriminated on `is_valid`).
const report = await client.validate(["domain = 'demo'"]);
if (report.is_valid) {
  // Run it and wait for the result (durable start + poll on the hosted API).
  const result = await client.startAndWaitForResult({ pipe_code: "demo.greet" });
  console.log(result.main_stuff ?? result.pipe_output);
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

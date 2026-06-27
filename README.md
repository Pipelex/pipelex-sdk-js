# @pipelex/sdk

TypeScript SDK for the **Pipelex hosted API** — execute MTHDS methods, manage runs, and call the product surface (methods catalog, organizations, billing, API keys, storage) from Node.

> Pipelex is the runtime/product. [MTHDS](https://mthds.ai) is the open standard it implements. This SDK speaks to the hosted Pipelex API; the pure protocol wire types it builds on come from the [`mthds`](https://www.npmjs.com/package/mthds) package via its `mthds/protocol` subpath.

## Status

Early scaffold. The `PipelexApiClient` and its routes are added in subsequent phases; today the package exposes only `SDK_VERSION`.

## Install

```bash
npm install @pipelex/sdk
```

## Usage

```ts
import { SDK_VERSION } from "@pipelex/sdk";

console.log(SDK_VERSION);
```

The client API (construction, `execute` / `start` / `validate`, run lifecycle, product routes) is documented in [`docs/architecture.md`](./docs/architecture.md) as it lands.

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

# pipelex-sdk-js (`@pipelex/sdk`)

TypeScript SDK for the **Pipelex hosted API**. It owns the Pipelex-branded product client: the request pipeline (auth, base URL, retries/timeouts/abort, problem-details), the protocol-execution routes (`execute` / `start` / `validate` / `models` / `version`), the run lifecycle, and the product surface (methods catalog, organizations, billing, API keys, storage, onboarding).

## Tech stack

| Concern        | Choice                                                            |
| -------------- | ---------------------------------------------------------------- |
| Language       | TypeScript, ESM-only (`.js` import extensions, `NodeNext`)       |
| Build          | `tsc` (`target ES2022`, full strict flag set) → `dist/`          |
| Test           | Vitest 4 + `@vitest/coverage-v8`                                 |
| Lint / format  | ESLint 9 flat config + Prettier 3 (double quotes, `printWidth 100`) |
| Boundaries     | `dependency-cruiser` (one-way `@pipelex/sdk → mthds/protocol`)   |
| Task surface   | `Makefile`                                                       |
| License        | MIT                                                              |

## Build & test

```bash
make install    # Install dependencies
make check      # Lint + format check + typecheck + build + depcruise (alias: make c)
make test       # Run the test suite (alias: make t)
make all        # Clean, check, and test
make build      # TypeScript compilation only
make clean      # Remove dist/ and tsbuildinfo
```

Always run `make check` before committing.

## Structure

Flat `src/` — the SDK has one client, so there is no runner/registry abstraction.

```
src/
├── index.ts        # Public barrel: re-exports mthds/protocol + the client/models/runs/errors
├── client.ts       # PipelexApiClient — request pipeline + all routes (implements MTHDSProtocol)
├── models.ts       # Dict concretes, /v1/validate surface, /v1/build/* req/resp models
├── runs.ts         # Run-lifecycle types + the single poll loop (pollUntilResult)
└── errors.ts       # Typed errors (derive from PipelineRequestError from mthds/protocol)
tests/              # Vitest suites (mock the fetch boundary)
docs/               # Architecture and surface documentation
```

## Architecture

The dependency direction is strictly one-way: `@pipelex/sdk → mthds`, and only through the published `mthds/protocol` subpath — never a deep import into `mthds` internals, and `mthds` must never import from `@pipelex/sdk`. `dependency-cruiser` enforces this.

The client re-implements the official MTHDS protocol routes using MTHDS *types* (from `mthds/protocol`); it does not delegate to the `mthds` package's protocol client. This keeps route shapes pinned to the standard so they can't silently diverge.

**Brand boundary:** MTHDS-branded concepts (protocol wire models, the standard validation shapes) belong to `mthds`. Pipelex-branded concepts (`PipelexApiClient`, run lifecycle, `PipelexValidationResult`, hosted-product errors, the product catalog/billing/keys surface) belong here. Inside a Pipelex envelope, keep neutral field names (`bundle_blueprint`, `pipe_structures`, `graph_spec`) — do not stamp `pipelex_` onto standard artifacts.

See [`docs/architecture.md`](./docs/architecture.md) for the full narrative as the client surface lands.

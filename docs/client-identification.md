# Client identification (`User-Agent` and `appInfo`)

Every request `PipelexApiClient` sends to the Pipelex API carries a `User-Agent` header that says which program made it. The hosted platform parses that header into the client surface it reports in product analytics and in its access log, which is how it tells a run started by an SDK script from one started by the web app, the MCP server, the CLI or the coding-agent hook. The convention is shared by every first-party client and is fixed by the workspace spec `docs/specs/client-identification.md`; this page describes how this SDK implements it.

## What the SDK sends

The value is a sequence of RFC 9110 product tokens, outermost first: the integrator's program (when it names itself through `appInfo`), then this SDK, then the runtime.

```
pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)
acme-invoicer/1.4.0 pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)
```

The SDK token is `pipelex-sdk-js/<SDK_VERSION>`, where `SDK_VERSION` is the package version (a test keeps it equal to `package.json`). The runtime token is `node/<version>`, `bun/<version>` or `deno/<version>`, followed by `(<os>; <arch>)`; when the runtime's version cannot be read the runtime token is left out. The SDK calls `fetch` itself, so no other library appears between the SDK token and the runtime.

The header is built once, when the client is constructed, and one private helper assembles the headers of every API request, so the protocol routes, the product routes, the extension routes and the origin-level `health()` probe all carry it. The fetch of a presigned object-store link by `fetchArtifact` or `downloadArtifacts` is a request to a third party and carries no header at all, as before.

**In a browser the SDK sets no `User-Agent`.** Browsers either ignore the header or turn it into a CORS preflight the API refuses, so a page running the SDK is identified by the browser's own `User-Agent`. The SDK treats a global `window` with a `document`, or a web worker, as a browser.

The header is self-declared and unauthenticated. The platform uses it for analytics and diagnostics only, never for authorization, rate limits or entitlements.

## Naming your program with `appInfo`

An integrator puts its own name in front of the SDK's token by passing `appInfo` at construction, in the same shape as Stripe's option of that name:

```ts
import { PipelexApiClient, type AppInfo } from "@pipelex/sdk";

const appInfo: AppInfo = {
  name: "acme-invoicer",
  version: "1.4.0",
  details: ["batch"],
  url: "https://acme.example",
};
const client = new PipelexApiClient({ appInfo });
// User-Agent: acme-invoicer/1.4.0 (batch; +https://acme.example) pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | An RFC 9110 token: ASCII letters, digits and the punctuation RFC 9110 allows in a token (no spaces, slashes, parentheses or semicolons), lowercase kebab-case by convention |
| `version` | no | A token, such as `1.4.0` |
| `url` | no | A URL, rendered in the comment as `+url` |
| `details` | no | Comment parameters, each a token or `token=value` (the value may be `name/version`), rendered before `+url` |

It renders as `name/version (<details>; +url)`, dropping the `/version` and the comment when they are empty. The constructor validates it and throws a `TypeError` naming the field when a value falls outside the grammar, and a `RangeError` when the whole header would exceed the spec's 512-character ceiling, in a browser as on a server although no header is sent there; the SDK never silently drops or rewrites a field. The header must never carry a secret, a user identifier, an email or a hostname.

First-party programs name themselves the same way. The coding-agent validation hook bundled in `dist-hooks/check.mjs` constructs its client with `appInfo: { name: "pipelex-mthds-check", version: SDK_VERSION }` (`src/hooks/validate-client.ts`), so its requests read:

```
pipelex-mthds-check/0.21.0 pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)
```

A subclass of `PipelexApiClient`, such as the MCP server's size-guarded client, inherits the option through the constructor and passes its own `appInfo` the same way.

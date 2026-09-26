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

## Building the header yourself

A program that makes some of its requests to the API with its own `fetch` rather than through the client (a web app's hand-rolled routes, an MCP server's raw probe) should send the same `User-Agent` on them. The package entry exports the builder the client itself uses, so there is no format to re-implement:

```ts
import { buildUserAgent, validateAppInfo, MAX_USER_AGENT_LENGTH, type AppInfo } from "@pipelex/sdk";

const appInfo: AppInfo = { name: "acme-invoicer", version: "1.4.0" };
const userAgent = buildUserAgent(appInfo);
// "acme-invoicer/1.4.0 pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)", or undefined in a browser
await fetch(url, { headers: userAgent ? { "User-Agent": userAgent } : {} });
```

| Export | Signature | Behaviour |
| --- | --- | --- |
| `buildUserAgent` | `(appInfo?: AppInfo, runtime?: RuntimeInfo) => string \| undefined` | Returns exactly the value a `PipelexApiClient` constructed with the same `appInfo` sends. Returns `undefined` in a browser, where no header may be set. Throws a `TypeError` for an invalid `appInfo` and a `RangeError` when the value would exceed `MAX_USER_AGENT_LENGTH`, in a browser as on a server. `runtime` defaults to the detected runtime and exists for tests; callers leave it out. |
| `validateAppInfo` | `(appInfo: AppInfo) => void` | Throws the same `TypeError` the constructor throws when a field falls outside the grammar. It does not check the length, which depends on the rest of the header: call `buildUserAgent` to check both. |
| `MAX_USER_AGENT_LENGTH` | `512` | The spec's ceiling on the whole header value. |

Compute the value once per process and reuse it, as the client does. The same rules apply as for the client: set it only on requests to the Pipelex API, never on a request to a third party.

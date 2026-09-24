# Input preparation (`uploadFile` / `prepareInputs`)

> **Status: implemented** (`src/upload.ts`, `src/upload-grant.ts`, `src/prepare-inputs.ts`). This document records the contract, and is the public account of it. The raw `upload()` primitive described in [architecture.md](./architecture.md) is the wire call `uploadFile` and `prepareInputs` build on.
>
> **Current scope.** `prepareInputs` names the method the same three ways every other method-taking operation does — inline `files`, a `method_ref` address, or a stored `method_id` — exactly one per call, all three resolved server-side by the one `validate` call it composes. One piece remains deliberately deferred and additive (it does not change this contract): the opt-in ingest of `http(s)` URLs into storage — for now an `http(s)` URL at a file position always passes through unchanged.

## Why this exists

A hosted run cannot see the caller's filesystem or a browser's selected bytes. Turning caller-local assets into run-ready inputs is therefore the SDK's job, not the runner's — the SDK process is the only component that can read the local file or hold the browser bytes. Today that work is re-implemented by every consumer (read file → base64 → `POST /v1/upload` → rewrite the input to the returned URI). `prepareInputs` makes it one reusable, explicit operation.

Preparation is **explicit and separate from running.** `execute` / `start` never silently upload local files. The payoff: file-access errors happen *before* a run exists, prepared inputs are inspectable and reusable across a model sweep or retries without re-uploading, and `start` keeps a deterministic JSON-input contract.

## The operations

### `uploadFile` — single-asset convenience

Uploads one asset and returns its upload record. It is the language-native convenience over the raw `upload()` wire call (base64 JSON body), assembling the record client-side.

- **Accepted sources (every runtime — browser, Node, edge):** `Blob`, `File`, `ArrayBuffer`, `Uint8Array`.
- **Path strings are Node-only.** A filesystem path string is read from disk, which only a process that owns a filesystem can do. In a non-Node runtime a path string fails instructively rather than being misread — the SDK does not silently treat it as text or as a URL.
- A string that is an **HTTP(S) URL** or an existing **`pipelex-storage://` URI** is not a local asset and passes through in any runtime (see pass-through rules below).
- Open file objects and streams are **deferred** — they can be added later without removing anything.

> **Runtime acceptance vs. bundling.** These source types are accepted at *runtime* in every environment, but at the *packaging* level the main `@pipelex/sdk` entry is **Node-first**: it statically references `node:fs/promises` (to read path strings), so bundling it for a browser or edge target requires marking `node:*` external. This is a deliberate stance — the client holds an API key, so it runs server-side (Next.js Server Actions, the MCP server, the plugins hook). A browser page that must store a file uses the upload grant below instead, whose sender ships from the browser-safe `@pipelex/sdk/upload` entry.

The returned **upload record** guarantees, beyond the source identity:

| Field | Guarantee |
| --- | --- |
| `uri` | The `pipelex-storage://` reference for the uploaded asset. |
| `contentType` (MIME) | Known client-side at upload time. |
| `size` (bytes) | Known client-side at upload time. |
| `filename` | Already in the wire model. |
| checksum | **Not present.** Within-preparation dedup relies on source identity, not hashing; cross-preparation dedup is a hosted storage-policy concern (Phase 5). |

The MIME type and size are known client-side, so the record is assembled without extending the `/v1/upload` response.

### Uploading with a grant — `requestUploadGrant` / `uploadWithGrant`

`uploadFile` needs the client, and the client needs the API key. A browser page holds the bytes but must never hold the key, so the work is split in two: the side holding the key requests a **grant** for one file, hands it to the page, and the page sends the file straight to storage with it. The bytes cross neither the credential-holding server nor the API gateway, so the gateway's request quota, which caps a base64 `/v1/upload` near 7.5 MiB, does not apply: the file may be as large as the service's own limit, which the grant reports as `max_bytes`.

**Requesting the grant** is a client method over `POST /v1/upload/grant`:

```ts
const grant = await client.requestUploadGrant({
  filename: file.name,
  content_type: file.type, // optional; empty or omitted signs no type
  size: file.size,
});
// { uri, url, headers, expires_at, max_bytes }
```

The file is described, never sent. The grant (`UploadGrant`) is a presigned, create-only `PUT` for one new object under the caller's organization: `url` is where to send it, `headers` are the signed headers to send unchanged, `uri` is the `pipelex-storage://` reference the object will carry, and `expires_at` is when storage stops accepting it, a few minutes later. The wire is snake_case like every product route, so the grant can travel to the page as JSON without a remap. A declared `size` over the limit is a `413` `ApiResponseError` whose `code` is `payload_too_large`, and a deployment without the route answers a `404`.

**The grant is a bearer capability.** Until it expires, whoever holds it can write that one object, so the SDK never logs it, and its caller should not either. The route never replays a grant for a repeated request: a caller that lost one asks for a new one.

**Sending the file** is the standalone `uploadWithGrant(grant, file, { signal?, timeoutMs? })`, which takes a `Blob` or a `File` and returns `{ uri }`:

```ts
import { uploadWithGrant, RejectedAssetError } from "@pipelex/sdk/upload";

const { uri } = await uploadWithGrant(grant, file);
```

It sends the file as the raw body of a `PUT` to `grant.url`, with `grant.headers` exactly as received. The grant signed `Content-Length` too, and the body sets it, so the file must be exactly the declared size. Redirects are refused rather than followed, because a presigned URL is valid only at the address it was signed for. **The `uri` names nothing until the `PUT` has succeeded**, so fill a form field or a run input with it only after `uploadWithGrant` resolves.

**The time limit.** The whole exchange with storage runs under a time limit — the request, the file going out, the answer coming back and the read of an error body — so a stalled upload settles even when the caller passes no signal. By default the limit is 60 s plus 1 s for every started 128 KiB of the file, which assumes about 1 Mbit/s and comes to 460 s for a 50 MiB file. `timeoutMs` replaces the default, for a slower link or a caller that wants a tighter bound; it must be a positive number no larger than 2147483647, the longest delay a timer honours, or the call throws an `InputPreparationError` before anything is sent. A `signal` ends the upload whenever it fires, so it can shorten the limit but never lengthen it, and a caller's abort still propagates as the signal's own reason even when the limit ran out too. When the limit runs out the call throws an `UploadTransportError` whose `code` is `timeout` and whose message names the seconds allowed. Whether storage stored the file is then unknown: retrying with the same grant before it expires either stores the file or answers the `412` of a used grant, and then the grant's `uri` already names the file. The grant's expiry does not bound the upload, because storage checks the signature when the request starts, not when it ends.

**The browser-safe entry.** `uploadWithGrant`, the grant types and the three error classes it raises (`InputPreparationError`, `RejectedAssetError`, `UploadTransportError`) are exported from `@pipelex/sdk/upload`, whose import graph reaches no Node builtin, no `undici` and not the client, so a page bundles it with nothing marked external. They are the same function and the same classes the main entry exports, so an `instanceof` check agrees whichever entry the error came through. The unit suite bundles the entry for the browser with esbuild and fails if anything Node-only becomes reachable.

**Storage's refusals** map onto the input-preparation errors, so a caller that already handles `uploadFile` needs no new case:

| Storage answers | Error | `code` | Meaning |
| --- | --- | --- | --- |
| `2xx` | none | | Stored; `uri` names the object. |
| `412 PreconditionFailed` | `RejectedAssetError` | `grant_used` | The grant was already used. A grant writes one object, once — so after an earlier attempt that failed at storage, the grant's `uri` may already name the file. |
| `403 SignatureDoesNotMatch` | `RejectedAssetError` | `signature_mismatch` | The file's size, content type or metadata differ from what the grant signed. |
| `403 AccessDenied`, "Request has expired" | `RejectedAssetError` | `grant_expired` | The grant expired. |
| `403 AccessDenied`, headers "not signed" | `RejectedAssetError` | `unsigned_header` | The request carried a storage header the grant did not sign. |
| `400 RequestTimeout` | `UploadTransportError` | `storage_timeout` | Storage stopped waiting for the body and wrote nothing, so the same grant can be retried while it is valid. |
| `409 ConditionalRequestConflict` | `UploadTransportError` | `conflict` | Another upload with the same grant was still in progress. Whether the object was written is unknown, so the same-grant retry applies. A grant is meant to be sent once at a time. |
| any other `4xx` | `RejectedAssetError` | `store_refused` | Storage's own message is relayed. |
| `5xx` | `UploadTransportError` | `server_error` | Whether the object was written is unknown: retrying with the same grant either stores it or answers the `412` of a used grant. |
| a redirect | `UploadTransportError` | `redirected` | Refused, not followed. |
| nothing within the time limit | `UploadTransportError` | `timeout` | The limit above ran out first. Whether the object was written is unknown, so the same-grant retry applies. |
| no response | `UploadTransportError` | `unreachable` | Storage unreachable. In a browser a refused cross-origin request looks exactly like this, so the message also points at the page's CSP `connect-src`. If the connection failed after the file went out, the object may have been written, so the message gives the same-grant retry too. |
| nothing sent | `UploadTransportError` | `invalid_grant_url` | The grant's `url` is not an absolute `http(s)` URL free of user info, so it is refused before any request. A browser would resolve a relative URL against the page and send the credential there. |

`RejectedAssetError.code` and `UploadTransportError.code` are what a caller branches on — to request a new grant on `grant_used` or `grant_expired`, to retry with the same grant on `timeout` or `server_error`, or to tell a timeout from an unreachable host — rather than the message, the status or the error's `name`, since an expired grant and an unsigned header both answer `403 AccessDenied` and only S3's message tells them apart. The SDK sets `code` on every error it raises. `RejectedAssetError.status` is storage's, and its `filename` is the `File`'s name, or the object name the grant's `uri` ends in for a nameless `Blob`. `UploadTransportError.status` is storage's status when storage answered, and undefined when it did not. Neither error wraps storage's response, and only S3's error code and message reach a message: its error body can echo the signed request, credential included, so it is never kept, and only its first 16 KiB are read, which is where S3 writes its code and message. **No error carries the grant's URL.** The runtime's network error can: Node and Chrome name the whole URL when they cannot build a request from it, and Bun puts it on the error's `path`. So an unreachable storage is described by its origin and by the error names and codes along the cause chain (`TypeError, caused by Error ENOTFOUND`), and the runtime's error is neither relayed nor kept as `cause`. A caller's abort propagates as the signal's own reason, unwrapped, including one that lands while storage's error body is still arriving.

### `prepareInputs` — signature-driven input preparation

```
client.prepareInputs({ files,      pipe_ref?, inputs }) → PreparedInputs
client.prepareInputs({ method_ref, pipe_ref?, inputs }) → PreparedInputs
client.prepareInputs({ method_id,  pipe_ref?, inputs }) → PreparedInputs
```

Takes the **method** as exactly one of three selectors, the optional target **pipe**, and the caller's `inputs`; resolves the pipe's declared input signature; interprets the inputs top-down against it; uploads the file-bearing values; and returns `PreparedInputs`. Per input, the caller may submit **either** the compact value **or** the explicit `{ concept, content }` envelope — see "[Compact or explicit-envelope inputs](#compact-or-explicit-envelope-inputs)" below:

- `inputs` — a **copy** of the caller's inputs with each asset reference replaced by the canonical content shape carrying `pipelex-storage://` in its `url` field (see "Rewritten-input shape" below). Copy-on-write: the caller's original object is never mutated.
- `uploads` — one upload record per prepared asset (the `uploadFile` record shape), exposing `uri` so callers can log which source became which reference without reverse-engineering the rewritten object.

The prepared `inputs` are passed to the existing run lifecycle unchanged.

#### The three selectors

Exactly one per call. The type pins the other two to `never`, so a second selector is a compile error; an untyped caller gets an `InputPreparationError` naming the three forms. **Empty is absent** — `files: []`, `method_ref: ""`, `method_id: "  "` — mirroring the run options' rule, so an empty selector may sit beside a real one without tripping the XOR.

| Selector | What it is | Who resolves it |
| --- | --- | --- |
| `files` | the inline MTHDS closure (`{content, source?}` entries) | nobody — inline |
| `method_ref` | a published method's address, `github.com/<owner>/<repo>[/<selector>][@<tag>]` | the runner, server-side (pipelex-api >= 0.21.0 fetches the repository at the tag) |
| `method_id` | a stored method's catalog id (`mt_…`) | the hosted platform, which injects the stored source before the runner sees the request |

Nothing is expanded client-side: `method_id` here is a **pass-through**, the same rule every other id-taking operation follows. `getMethodClosure` stays available for callers that want the files in hand, but it is no longer a step on the way to preparing inputs.

#### Where the signature comes from

One `POST /v1/validate` per call, whatever the selector, asking for the **input-form descriptor**:

```
validate(<selector or contents>, allowSignatures = true, …, views = ["input_form"])
```

`allowSignatures: true` is deliberate. Preparation needs a pipe's *declared* inputs, and a bundle mid-authoring with an unresolved signature somewhere else must not be refused inputs for a pipe whose inputs are declared — whether the bundle runs is the run's verdict, not preparation's. An `is_valid: false` verdict still means the closure does not load, which is a preparation failure.

A `method_ref` makes the server clone a repository first; `validate` needs no special budget for it, because the route already defaults to the 20-minute execute ceiling.

#### Pipe selection

`validate` has no pipe selector — its report describes every pipe, keyed by qualified `pipe_ref` — so the helper picks one, in this order:

1. **`pipe_ref` when given.** Qualified-only: `domain.pipe_code`. A bare code, or a ref the method does not declare, is an `InputPreparationError` listing the qualified refs — one step to fix. The helper never grows a searched `pipe_code`: search is a run-route affordance, and the descriptor is keyed by qualified refs. An `alias->domain.pipe_code` ref is refused for a different reason: the descriptor describes the method's *own* pipes, and an alias names one belonging to a dependency package, which the report never carries a descriptor for — the run route takes such a ref, preparation cannot.
2. **The report's resolved default** (`default_pipe_ref`): the qualified ref of the pipe a selector-less run of *this same method* would execute, manifest-aware for a fetched package. It is read on the field's **presence**, never on its truthiness, and has three arms:
   - a **non-empty string** is the default and is walked — and if the descriptor does not describe it, preparation refuses rather than falling through, since one report keyed by one pipe set naming a pipe it does not describe is the report contradicting itself;
   - a **stated `null`** — or any stated value that is not a non-empty string — is the server saying it determined no entry pipe: no blueprint declares a `main_pipe`, or the package manifest names a pipe the closure does not declare or declares in several domains. A run naming no pipe is refused in exactly those cases, so preparation refuses too and asks for `pipe_ref`. Steps 3 and 4 are **not** consulted behind it;
   - an **absent field** means the runner predates it, and only then do steps 3 and 4 stand.
3. **The bundle's declared `main_pipe`** — behind an absent field only — read defensively from the opaque `bundle_blueprint` and qualified by its `domain`.
4. **The single pipe** — behind an absent field only — when the method declares exactly one.
5. Otherwise an `InputPreparationError` naming the candidates and asking for `pipe_ref`.

> **The manifest-only `main_pipe` gap is what step 2 closes.** A published package may name its entry pipe in `METHODS.toml` alone — `github.com/Pipelex/methods/documents` and `.../image_generation` do — and the validate report carries no manifest; the runner resolves the manifest server-side and states the result in `default_pipe_ref`, so such a package prepares with no `pipe_ref`. A manifest naming a pipe the closure does not declare, or declares in several domains, is the stated `null` instead: the run would fail on that code, and preparation says so before anything is uploaded.

## `getMethodClosure` — the explicit expansion utility

```
client.getMethodClosure(methodId) → MthdsFileItem[]
```

`getMethodClosure` is the public **local expansion utility** — a client-side semantic layer over `getMethod` (the platform has no route that returns a parsed closure). It fetches the method, parses its polymorphic `mthds` source with [`methodSourceToContents`](#methodsourcetocontents--the-canonical-source-parser), and labels each resulting file with the `method_id` as its `source` provenance.

Reach for it whenever you want the files **in hand** — to edit, to diff, or to feed a route with no by-id form:

```
client.buildInputs({ files: await client.getMethodClosure("mt_…"), pipe_ref?, format?, explicit? })
```

`/v1/build/*` is the last such family, and it is being retired. Every other method-taking operation — `execute` / `start`, `validate` / `resolve` / `codegen`, and now `prepareInputs` — takes a `method_id` **natively**, as a server pass-through: the platform resolves it and injects the stored source before the runner sees the request (see [architecture.md → hosted run extensions](./architecture.md#hosted-run-extensions-method_id)). That is the uniform rule — *an id option is always a server pass-through, and any client-side expansion is the caller's own explicit call*. An untyped caller still passing `method_id` to `buildInputs` gets a teaching error naming this migration (`PipelineRequestError`); for typed callers the field is a compile error.

- **Requires an API key.** The methods catalog is org-scoped to the key's org, so resolution only works with an authenticated Pipelex-product key.
- **Unknown or foreign-org id → the `getMethod` `404`** (`ApiResponseError`, `code: "not_found"`), propagated unchanged. An id from another org is indistinguishable from a nonexistent one — both 404.
- **A real, in-org method whose source parses to nothing → `EmptyMethodSourceError`** — the row exists but has no runnable MTHDS source yet. This is a distinct outcome from the 404 (see "[Error and capability behavior](#error-and-capability-behavior)"), and `getMethodClosure` is now its only raiser: `prepareInputs` passes the id to the server, which answers a sourceless method with a `422`.

### `methodSourceToContents` — the canonical source parser

```
methodSourceToContents(mthds: string) → string[]
```

A stored method's `mthds` field is **polymorphic**: it is either the raw single-bundle source, or a JSON array of `{ name, content }` file entries (a multi-file closure). `methodSourceToContents` is the one canonical parser that turns either shape into a flat list of file contents — a verbatim port of the platform's `_method_source_to_contents`, so the SDK and the runtime read a stored source identically. It is exported from the barrel for consumers (e.g. `pipelex-mcp`) that need the parse without the fetch. Blank entries are dropped; a source that parses to no non-blank content yields `[]`, which is what `getMethodClosure` turns into `EmptyMethodSourceError`.

## Compact or explicit-envelope inputs

Each input may be submitted in **either** of two shapes, and preparation treats them equivalently:

- **Compact** — the bare value: a source string / bytes / canonical `{ url }` content (e.g. `photo: "https://…/p.png"`).
- **Explicit envelope** — the `{ concept, content }` shape that `buildInputs({ explicit: true })` returns per input (e.g. `photo: { concept: "native.Image", content: { url: "https://…/p.png" } }`). This is the default template the hosted console and MCP hand agents to fill, so an agent that fills the template can hand it straight back.

When a value is an envelope (a plain object whose keys are **exactly** `concept` and `content` — matching the runtime's `_is_explicit` in `input_shaper.py`), preparation unwraps `content`, interprets it exactly as the compact value would be, and **re-wraps** the result — so the concept annotation rides through to the run. The runtime accepts the envelope as a run input (`input_shaper.py` `_is_explicit` / `_shape_explicit`), and file-reference resolution (`input_normalizer.py`) runs over the already-shaped content, so a re-wrapped `{ concept, content: { url: "pipelex-storage://…" } }` resolves identically to the compact `{ url }`. The envelope's `content` may itself be a scalar, a canonical file content, a list, or a structured object nesting file fields — the same top-down walk applies underneath.

## Signature-driven asset identification

The SDK **must not** guess that every string resembling a path is an asset — that would make ordinary text inputs environment-dependent and could upload unintended files. Interpretation comes from the method's **declared signature**, never from a value's shape alone. This mirrors the runtime's own top-down interpretation (`InputShaper`) combined with the file-reference resolution of `input_normalizer` in `pipelex`, so local and hosted execution read the same inputs the same way. (A caller value may be compact or the explicit `{ concept, content }` envelope — see "[Compact or explicit-envelope inputs](#compact-or-explicit-envelope-inputs)"; the walk below is over the compact value, i.e. the envelope's `content`.)

The declared signature is the **input-form descriptor** — the MTHDS standard's `input_form` artifact, carried on the validate report under `views: ["input_form"]`. It states the kind of every input at every depth, so a file position is a *fact of the method*, never an inference from the value in front of it.

The walk is discriminated on the node's `kind`:

| Node kind | What the walk does |
| --- | --- |
| `document`, `image` | A **file position.** The caller's value there is resolved: a local path, `data:` URL, or bytes is uploaded and rewritten to canonical content carrying `pipelex-storage://` in `url`; an `http(s)` URL or an existing storage URI passes through; a canonical `{ url }` content dict has its `url` resolved and its other keys preserved. |
| `object` | Walks the declared `fields` by name against a plain-object value. Keys the descriptor does not name are copied through untouched. **Optional fields (`required: false`) are walked when present.** |
| `list` | Walks `item` against each element of an array value. |
| everything else (`text`, `prose`, `date`, `number`, `boolean`, `enum`, `unknown`) | Passes through at any depth. |

Two consequences worth stating outright, because they are what the descriptor buys:

- **Whether a concept is native or refines `Document` / `Image` is the descriptor's statement** (`refines`), never a shape test. A concept refining `native.Document` arrives as `kind: "document"` and is prepared as one.
- **`unknown` is not interpreted.** It is the standard's escape hatch for a `Dynamic` / `Composite` input, and the walk does not enter it — including a canonical file dict nested inside one. The signature genuinely declares no file there, and uploading on the strength of a `url` key is precisely the guess this helper stopped making. A caller with such an input uploads with `uploadFile` first and passes the storage URI.

A repeated reference to the **same source** within one preparation is uploaded once and rewritten consistently (within-preparation dedup by source identity). A caller value whose shape disagrees with the node — a scalar at an `object`, a non-array at a `list` — passes through for the run to reject; preparation never second-guesses the signature.

> **Why the descriptor, and why not the template.** Preparation used to read the *explicit inputs template* (`buildInputs` with `explicit: true`), whose file signal was a rendered `{"url": …}` dict. That signal is a side effect of a field being **named** `url` or `*_url`, not of the field being an Image or a Document — so a text field named `url` was read off the caller's disk and uploaded, and an **optional** nested file field, which the required-only template never rendered, was invisible and travelled to the runner as a literal path. Both were live misclassifications. The descriptor states the kind instead of implying it, and states it at every depth, so both edges fall out correctly rather than needing special cases. It costs the same one round trip, it is the standard's own artifact rather than a presentation of it, and it is what `@pipelex/mthds-form`, `pipelex-app`, `mthds-ui` and `pipelex-mcp` already derive from. The template remains what it always was — a fill-in scaffold for a person or an agent — and is projected from this same descriptor.

### Pass-through rules

| Source at a file-bearing input | Action |
| --- | --- |
| Local path (Node) / data URL / bytes | Upload → rewrite to `pipelex-storage://` |
| Existing `pipelex-storage://` URI | Already prepared — pass through unchanged |
| HTTP(S) URL | Pass through unchanged, **unless** the caller explicitly asks to ingest it into Pipelex storage |

## Rewritten-input shape: `url` carries the URI

The runtime's canonical image/document content stores its reference in a **`url`** field. Preparation emits inputs the runtime interprets natively, so a rewritten input keeps the canonical content shape with `url` holding the `pipelex-storage://` value — exactly what the runtime's `input_normalizer` writes.

The "uploaded reference is named `uri`" decision applies to the **upload surface**: the raw upload result and each upload record expose the storage reference as `uri`. Preparation must **not** invent a `uri` field inside rewritten inputs — that would produce inputs the runtime does not recognize.

## Error and capability behavior

Upload is a **hosted Pipelex-product capability**, even though the SDK can be pointed at other base URLs. A deployment that does not support upload must produce a specific, actionable error — preparation must never silently leave a local path in place and let a later run fail obscurely.

The contract distinguishes these semantic outcomes, each a typed subclass of `InputPreparationError` (catch the base to handle any preparation failure, a subclass to branch on category):

- **an unresolvable signature** (`InputPreparationError`) — the closure did not validate (`is_valid: false`, carrying the first error's message), the report carried no `input_form` descriptor, or no pipe could be chosen (an unknown or bare `pipe_ref`, or no default). A *no-verdict* condition from `/v1/validate` — a malformed selector, an unknown or foreign-org `method_id`, no package at the address, auth, a server fault — stays an `ApiResponseError` and propagates unchanged;
- **empty method source** (`EmptyMethodSourceError`, carries `methodId`) — `getMethodClosure` found the stored method but its `mthds` source parses to nothing (the row exists, no runnable source yet). Distinct from the `getMethod` `404` for an unknown/foreign id, which stays an `ApiResponseError`. `prepareInputs` never raises it: it hands the id to the server, which answers a sourceless method with a `422`;
- **invalid local source** (`InvalidLocalSourceError`) — missing, unreadable, or a path string outside Node;
- **rejected asset** (`RejectedAssetError`) — the server refused it (e.g. a `413` past the service-defined size cap — see "Storage policy" — surfaced as a clear rejection with `code` `too_large`, not a raw transport error), or storage refused an upload with a grant (a used or expired grant, or a file that differs from what the grant signed — see the table above for each `code`);
- **unsupported server capability** (`UnsupportedUploadCapabilityError`) — the configured deployment has no upload route;
- **authentication / authorization failure** (`UploadAuthenticationError`) — `401` / `403`;
- **transport failure** (`UploadTransportError`) — a network or server fault, or any other unexpected upload failure; its `status` is the HTTP status when a response produced it, and its `code` says which failure it was. From `uploadFile` the code is `server_error` for a `5xx`, `timeout` when the client's own request timeout ran out, `unreachable` when no response came back, and `unexpected` for any other status or failure; `uploadWithGrant`'s codes are in the table above.

A malformed data URL — no comma, bad base64, bad percent-encoding — is a plain `InputPreparationError`, raised while the asset is read and before anything is uploaded.

All preparation failures are raised **before any run is created**.

## Storage policy (inherited, Phase 1)

The SDK ships against **today's route behavior**: a service-defined size cap (hosted default 50 MiB via `MAX_UPLOAD_MIB`, rejected with `413`), auth required, per-user keys, and nothing else — no MIME validation, retention, quotas, dedup, or cleanup. The SDK documents limits as **service-defined** and surfaces server rejections as clear "rejected asset" errors; it does **not** hardcode a client-side cap. Real storage policy (retention, quotas, org scoping, cleanup) is a later hosted-owner deliverable.

## Stability across the future endpoint move

The public abstraction sits deliberately **above** the HTTP route. Callers depend on `uploadFile` / `prepareInputs`, the `uri` result field, and the `pipelex-storage://` scheme — never on which backend service owns the route. The current transport is `POST /v1/upload` on `pipelex-api`; when hosted storage upload later moves to `pipelex-platform` (together with its paired resolution route, as one storage domain), the public path and wire shape are kept compatible so released SDK versions keep working, and any wire-protocol change is absorbed inside the SDK's upload transport. `uploadFile`, `prepareInputs`, and the prepared run-input shape stay stable across that move.

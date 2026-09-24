# Artifact download (`locateArtifacts` / `collectArtifacts` / `resolveArtifacts` / `fetchArtifact` / `downloadArtifacts`)

> **Status: implemented** (`src/artifacts.ts`). This is the download twin of [input preparation](./input-preparation.md): where `prepareInputs` turns local files into `pipelex-storage://` references before a run, these operations turn the references a run produced back into bytes on disk, or into a bounded stream, afterwards. They are layered so that each is usable without the next.
>
> **They need a platform that serves the bulk resolve route.** Everything below the pure walk mints its links through `POST /v1/resolve-storage-url/bulk`, a hosted-platform route. The public bare runner (`pipelex-api`) has no resolve route at all, single or bulk, and a hosted deployment that predates the route answers a `404`; in both cases the operation throws the existing `ApiResponseError` and nothing is downloaded. `resolveStorageUrl`, the single-reference primitive, stays for the callers that have one link to mint.

## Why this exists

A run that produces an image, a PDF or a document does not embed the bytes in its results. The content carries the file's durable reference — a `pipelex-storage://` URI in its `url` field — beside a `public_url` the storage provider signed when the run wrote the file. That signed link is short-lived and must not be stored, so every consumer that wanted the file had to walk the result for references, mint a fresh link per reference, and stream each link to disk within sensible bounds. The MCP server did exactly that for itself; a method app needs the same walk to display a picture; a CLI needs it to save a report. `downloadArtifacts` makes it one explicit operation, and the layers under it make each step reusable on its own.

Downloading is **explicit and separate from running**, the input-preparation rule in reverse: `execute` / `start` never silently upload, and `startAndWaitForResult` never silently downloads. There is no `download` option on any run call. A download is its own gesture, inspectable and repeatable — by run id, days after the run.

Nothing here reads the embedded `public_url`. Every link is minted fresh by the platform, which is what makes a download work long after the embedded link died, and what keeps the tenant boundary where the platform enforces it.

## The operations

### `locateArtifacts(value)` and `collectArtifacts(value)` — the pure walk

```ts
import { collectArtifacts, locateArtifacts } from "@pipelex/sdk";

const locations = locateArtifacts(results.main_stuff);
// [{ uri: "pipelex-storage://org/runs/01J…/outputs/2325fcfe.png",
//    found_at: ["$.rooms[0].staged_photo.url"] }, …]

const uris = collectArtifacts(results.main_stuff);
// ["pipelex-storage://org/runs/01J…/outputs/2325fcfe.png", …] — the same walk, references only
```

Walks any JSON-shaped value and returns every string that **is** a `pipelex-storage://` reference — the whole string, scheme first, with something after the scheme. A string that merely contains a reference does not count; the bare scheme does not count; nothing else is looked at. The result is deduplicated and kept in discovery order, the order of each reference's first sighting. It is a contract rather than a heuristic, because the scheme is unambiguous: the runtime serializes a produced file as content carrying its reference in `url`, and nothing else on the wire starts that way.

`locateArtifacts` also says where each reference sits. Its `found_at` lists every path at which the reference occurs, in walk order, so a reference the output repeats is one entry with several paths, and `found_at[0]` is where it was first seen — the path a saved file is named after. `collectArtifacts` is the same walk's references alone.

**Path notation.** A path is rooted at `$`, the walked value itself. An object key matching `^[A-Za-z_][A-Za-z0-9_]*$` is written `.key`, any other key `["…"]` in JSON string escaping, and an array index `[n]`. So a nested field reads `$.rooms[3].staged_photo.url`, a list member `$.items[0].url` (a list output arrives as the `{ items: [...] }` envelope), a key that is not an identifier `$["a key"].url`, and an output that is itself a reference `$`. A path is the exact location of the string, the final `url` of a content object included, so a consumer can follow it into the JSON without guessing.

Both are pure — no network, no key — and exported standalone, so a consumer can count, list or place a result's files without resolving any of them.

### `resolveArtifacts(uris)` — fresh links for a whole list

```ts
const resolved = await client.resolveArtifacts(uris);
for (const item of resolved) {
  if (item.error === null) {
    // item.url is fetchable now; item.expires_at says until when; item.content_type may be null
  } else {
    // item.error is { code, detail } — the route's own per-reference refusal
  }
}
```

One call to the platform's bulk route for the whole list, chunked at the route's bound of 100 references per request (`BULK_RESOLVE_MAX_URIS`), answering one `ResolvedArtifact` per reference **in request order, duplicates included**. A resolved item carries `url`, `expires_at` (UTC, ISO 8601) and `content_type` (`string | null` — the platform's guess from the reference's extension, null when it has none) with `error: null`; a refused item carries `error` as `{ code, detail }` with the three link fields null. The codes are the route's: `invalid_storage_uri` for a malformed reference and `forbidden` for one belonging to another organization. A consumer branches on `error`, never on an HTTP status, because the request is a `200` whenever every reference got a verdict.

Only what is not about a reference throws: the route's whole-request refusals (a caller with no organization, a request over the bound or with an unknown field, a signing failure, a deployment without the route) as `ApiResponseError`, and an unreachable host as `ApiUnreachableError`. An empty list resolves to an empty list with no request made. A link lives about fifteen minutes; resolve close to the moment of use.

This is where every browser-side or server-rendering consumer stops: it mints links on the server and hands each one to a client that uses it immediately. `resolveStorageUrls` is the raw wire call underneath it (one request, at most the bound), the way `upload` sits under `uploadFile`.

### `fetchArtifact(uri)` — one bounded stream

```ts
// A same-origin proxy: the API key stays on the server, the browser gets the bytes.
export async function GET(request: Request, { params }: { params: { uri: string } }) {
  const upstream = await client.fetchArtifact(params.uri, { signal: request.signal });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=60",
    },
  });
}
```

Resolves the reference fresh and returns the object store's response as a bounded `Response`. The bounds:

- **A timeout** covering the connection, the headers and the whole body (`timeoutMs`, default 120 s). On Node the fetch also runs on an `undici` dispatcher carrying `headersTimeout` and `bodyTimeout` at the same value, the per-stall bounds an `AbortSignal` alone does not give. It must be a positive number no larger than 2147483647, the longest delay a timer honours, or the call throws an `ArtifactOperationError` before anything is resolved.
- **Redirects refused** (`redirect: "manual"`): a presigned link has no reason to redirect, and one that does is refused rather than followed.
- **The byte cap enforced mid-stream** (`maxBytes`, default 1 GiB): a declared `Content-Length` over the cap is refused before a byte is read, and a body that crosses the cap while streaming errors the returned stream — never buffered.
- **No credentials forwarded**: the request carries no headers of ours. The link's authorization is in its query string, and nothing else may ride along to the store.
- **Plain `http:` refused** unless `allowHttp: true`. A general-purpose library does not fetch over plain http silently; the local compose stack's object store hands out such links, and that is what the option opts into.

It is **header-neutral**: the status, status text and headers are the store's own. The one change is that a `Content-Encoding` the fetch already decoded is dropped with the encoded `Content-Length`, since the body handed on is the decoded bytes. A proxy relaying it therefore owns the response hygiene — `X-Content-Type-Options: nosniff`, a sandboxing CSP on the asset response, a controlled `Content-Disposition`, private caching — and must set them itself, as the example does.

Only a `2xx` is returned. Anything else throws an `ArtifactFetchError` whose `code` says why, in the same closed vocabulary the download verdict uses per item: the route's `invalid_storage_uri` / `forbidden`, then `unsupported_url` (not a URL, not http(s), or carrying credentials), `plain_http_refused`, `redirect_refused`, `store_refused` (a 401/403 from the store — the link is freshly minted, so this is the store refusing a fresh signature, not an expired link), `not_found` (404/410), `store_error` (any other non-2xx, with `status`), `too_large`, `timeout` and `network`. The caller's abort propagates as-is, and the body reader is cancelled with it. `downloadArtifacts` and a proxy share this boundary: the download is the same fetch followed by a write.

### `downloadArtifacts({ run_id | results, dir, … })` — the files on disk

```ts
const verdict = await client.downloadArtifacts({
  run_id: "01J…", // or: results: <a RunResults in hand>
  dir: "./out/01J…",
  scope: "working_memory", // default "main_stuff"
});

console.log(verdict.saved_paths);
if (!verdict.all_saved) {
  for (const artifact of verdict.artifacts) {
    if (artifact.error !== null)
      console.warn(artifact.uri, artifact.error.code, artifact.error.detail);
  }
}
```

**Node-only**, like the path-string arm of `uploadFile`: it writes to a filesystem, and says so with an `ArtifactOperationError` anywhere else.

**Where it reads from.** Exactly one of `run_id` and `results`. A `run_id` re-reads the results through `getRunResult`, so a completed run is downloadable days later from its id alone; a `RunResults` already in hand is read as it is, with no request. `scope` picks the artifact walked for references: `main_stuff` (the default) is the run's output, and `working_memory` is the opt-in that also brings down the echoed inputs and every intermediate stuff — it is read off the parsed results body, whether or not `RunResults` declares the field.

**How it downloads.** The whole set is resolved through the bulk route ahead of the workers, then a bounded number of workers (`concurrency`, default 4) each take the next reference and fetch it → open its file with `wx` → stream the body in. Resolution is just-in-time where it matters: a link that has expired by the time its worker reaches it — a large set downloaded a few at a time can outlive the fifteen-minute link — is resolved again for that reference alone, so no fetch ever runs on a stale signature.

**Filenames: each file is named after the field it fills.** The name comes from the first path in the reference's `found_at`, by the rule `artifactFilename(location, contentType, scope)` (exported) applies:

1. A final `url` key is dropped, since the runtime's image and document contents carry their reference there. A reference under any other key keeps that key, and a `url` key that is not final is kept.
2. Each key is reduced to `[A-Za-z0-9_]`, every other character becoming `_` — `-` and `.` included, since one is the separator and the other would fake an extension. An index stays its digits.
3. The segments are joined with `-`. A reference that is the walked value itself, or its `url`, has no segment left and takes the scope's name, so an output that is one image is saved as `main_stuff.png`.
4. A name over the length cap (128 characters, extension included) keeps its tail: whole leading segments are dropped first, since the last ones are the specific ones, and a single segment still too long is cut to fit.
5. A stem Windows reserves for a device — `con`, `prn`, `aux`, `nul`, `com0` to `com9` or `lpt0` to `lpt9`, in any case — gets a trailing `_`, so a field named `aux` is saved as `aux_.png`. Windows reserves those names whatever the extension, and a field name is the method author's to choose.
6. The extension is the one the storage key's last segment carries, reduced to `[A-Za-z0-9]`, when it has a short one; otherwise the content type's, for the types a run produces (`image/png` gives `.png`, `application/pdf` gives `.pdf`); otherwise there is none.

For example, a home-staging method whose output is

```json
{
  "rooms": [
    {
      "original_photo": { "url": "pipelex-storage://org/assets/53174b03.png", "public_url": "…" },
      "staged_photo": { "url": "pipelex-storage://org/runs/01J…/outputs/2325fcfe.png", "public_url": "…" }
    },
    { "original_photo": { "url": "…" }, "staged_photo": { "url": "…" } }
  ]
}
```

is saved as `rooms-0-original_photo.png`, `rooms-0-staged_photo.png`, `rooms-1-original_photo.png` and `rooms-1-staged_photo.png`, where the storage keys alone (`53174b03.png`, `2325fcfe.png`) would not say which picture is which. Each verdict item's `found_at` carries the unreduced path, `$.rooms[0].staged_photo.url`.

The result is always a bare filename — ASCII letters, digits, `_` and the `-` joins, then an optional extension — never empty, never starting with a dot and never a device name, so it can name nothing but a regular file directly inside `dir`. `artifactFilename` takes a location from `locateArtifacts`, which is how a consumer predicts a name before downloading; it throws `ArtifactOperationError` for a location with no string `uri`, no `found_at` array, or one whose `found_at[0]` is not a path in the notation above, or for an unknown scope.

Files are **never overwritten**: a name already on disk gets a numeric suffix (`report-1.pdf`, `report-2.pdf`), through exclusive creation rather than an exists-check, so two workers cannot race for one name. Two references whose paths reduce to one name (`"staged photo"` and `"staged-photo"`) are told apart by the same suffix, and the verdict says which file is which. A reference found at several paths is saved once, under the name of the first. `dir` is created if missing.

**Cleanup.** A failed or aborted download unlinks its partial file; nothing truncated is ever left under a final name.

**The verdict.** A produced verdict, one entry per reference in discovery order:

```ts
{
  scope: "main_stuff" | "working_memory",
  artifacts: [
    { uri, found_at, path, content_type, size, error: null },       // saved — path is absolute
    { uri, found_at, path: null, content_type, size: null, error: { code, detail } },  // not saved
  ],
  saved_paths: [ /* the absolute paths of the saved ones, same order */ ],
  all_saved: boolean,   // every reference saved; vacuously true for an empty walk
  aborted?: true,       // present only when the caller's signal aborted the call
}
```

`artifacts.length` is the count of references walked, errors included. An empty walk over a present scope — an output that references no stored file — is a verdict with empty lists and `all_saved: true`, not an error, and it touches neither the network nor the disk. `found_at` is the reference's paths in the walked scope, exactly as `locateArtifacts` reports them, and `content_type` is the platform's guess from the reference, known before the fetch; both are on both arms, so an item that was not saved still says which field it would have filled.

Per-item `error.code` is the fetch vocabulary above plus the download's own: `resolve_failed` (an expired link could not be re-resolved, for a reason that is not the credential), `total_limit_exceeded` (the item that would take the call past `maxTotalBytes`, and, once the files already saved leave no room, every item not yet started, whose `detail` says it was skipped; an item refused only because files still in flight hold the room stops nothing else, since one of them may yet fail and give it back), `write_failed` (the file could not be created, written or closed) and `aborted` (in flight or not yet started when the signal fired).

**What it throws.** Only conditions with no verdict, all typed:

- `RunStillRunningError` (with the retry hint) or `RunFailedError` — a `run_id` naming a run that has not completed;
- `ScopeUnavailableError` — the requested scope's artifact is `null` or missing from the body (`scope` and `runId` on the error). Reading by `run_id`, a null `main_stuff` is already `MissingMainStuffError` from `getRunResult`;
- `ArtifactAuthenticationError` — the resolve route refused the credential (`401` / `403`), on the first resolve or on a re-resolve part-way through. It carries `verdict`, the result as it stood: the refusal stops the workers taking new items but lets the fetches already running finish, since they are on presigned links that do not carry the credential, so every file saved is real and listed and the rest are marked `aborted` with a detail naming the credential failure;
- `ArtifactOperationError` — outside Node, an unusable `dir`, both selectors or neither, an unknown `scope`, or nonsense bounds;
- and the transport and lifecycle errors of the reads it makes, unchanged: `ApiResponseError` for a deployment without the bulk route, `RunLifecycleUnavailableError` for a bare runner asked by `run_id`, `ApiUnreachableError`.

Everything else that can go wrong with one reference is that reference's `error`.

**Options and defaults.**

| Option          | Default        | What it bounds                                                                                                                                           |
| --------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`         | `"main_stuff"` | the artifact walked for references                                                                                                                       |
| `concurrency`   | `4`            | artifacts in flight at once                                                                                                                              |
| `maxBytes`      | 1 GiB          | one file, from `Content-Length` and again mid-stream                                                                                                     |
| `timeoutMs`     | 120 s          | one file's whole exchange, plus the dispatcher's per-stall timeouts                                                                                      |
| `maxTotalBytes` | 4 GiB          | the bytes the whole call saves, a file in flight counting its declared length                                                                            |
| `allowHttp`     | `false`        | whether a plain `http:` link is fetched                                                                                                                  |
| `signal`        | —              | cancels the call: in-flight fetches are cancelled and their partial files unlinked, the rest are marked, and the verdict comes back with `aborted: true` |

The per-file defaults are the MCP server's, which this replaces; the caps are accident guards against filling a disk from a runaway output, not judgments about artifact size.

## Round trip

The two directions compose. A file uploaded by `prepareInputs` is echoed in the run's working memory under the same reference, so a pass-through run brings it back byte for byte:

```ts
const prepared = await client.prepareInputs({ files, inputs: { doc: "./brief.pdf", note: "hi" } });
const results = await client.startAndWaitForResult({ files, pipe_code, inputs: prepared.inputs });
const verdict = await client.downloadArtifacts({
  run_id: results.pipeline_run_id,
  dir: "./out",
  scope: "working_memory",
});
// verdict.artifacts finds prepared.uploads[0].uri among the saved files
```

That is also the live e2e leg (`tests/e2e/artifacts.e2e.ts`), which needs a platform carrying the bulk route.

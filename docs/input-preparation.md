# Input preparation (`uploadFile` / `prepareInputs`)

> **Status: implemented** (`src/upload.ts`, `src/prepare-inputs.ts`). This document records the contract (design source: `wip/upload/README.md` in the workspace, tracked in `TODOS.md`). The raw `upload()` primitive described in [architecture.md](./architecture.md) is the wire call `uploadFile` and `prepareInputs` build on.
>
> **Current scope.** `prepareInputs` takes the method closure as inline `files` (the signature source). Two pieces are deliberately deferred and additive (they do not change this contract): resolving a closure from a catalog `method_id` (would duplicate the method-source parser that lives in `pipelex-mcp`/the platform), and the opt-in ingest of `http(s)` URLs into storage — for now an `http(s)` URL at a file position always passes through unchanged.

## Why this exists

A hosted run cannot see the caller's filesystem or a browser's selected bytes. Turning caller-local assets into run-ready inputs is therefore the SDK's job, not the runner's — the SDK process is the only component that can read the local file or hold the browser bytes. Today that work is re-implemented by every consumer (read file → base64 → `POST /v1/upload` → rewrite the input to the returned URI). `prepareInputs` makes it one reusable, explicit operation.

Preparation is **explicit and separate from running.** `execute` / `start` never silently upload local files. The payoff: file-access errors happen *before* a run exists, prepared inputs are inspectable and reusable across a model sweep or retries without re-uploading, and `start` keeps a deterministic JSON-input contract.

## The two operations

### `uploadFile` — single-asset convenience

Uploads one asset and returns its upload record. It is the language-native convenience over the raw `upload()` wire call (base64 JSON body), assembling the record client-side.

- **Accepted sources (every runtime — browser, Node, edge):** `Blob`, `File`, `ArrayBuffer`, `Uint8Array`.
- **Path strings are Node-only.** A filesystem path string is read from disk, which only a process that owns a filesystem can do. In a non-Node runtime a path string fails instructively rather than being misread — the SDK does not silently treat it as text or as a URL.
- A string that is an **HTTP(S) URL** or an existing **`pipelex-storage://` URI** is not a local asset and passes through in any runtime (see pass-through rules below).
- Open file objects and streams are **deferred** — they can be added later without removing anything.

The returned **upload record** guarantees, beyond the source identity:

| Field | Guarantee |
| --- | --- |
| `uri` | The `pipelex-storage://` reference for the uploaded asset. |
| `contentType` (MIME) | Known client-side at upload time. |
| `size` (bytes) | Known client-side at upload time. |
| `filename` | Already in the wire model. |
| checksum | **Best-effort, not guaranteed.** Within-preparation dedup relies on source identity, not hashing; cross-preparation dedup is a hosted storage-policy concern (Phase 5). |

The MIME type and size are known client-side, so the record is assembled without extending the `/v1/upload` response.

### `prepareInputs` — signature-driven input preparation

```
prepareInputs(methodRef, pipe, inputs) → PreparedInputs
```

Takes the **method reference** (bundle files or catalog `method_id`) plus the target **pipe**, resolves the pipe's declared input signature, interprets the caller's compact `inputs` top-down against that signature, uploads the file-bearing values, and returns `PreparedInputs`:

- `inputs` — a **copy** of the caller's inputs with each asset reference replaced by the canonical content shape carrying `pipelex-storage://` in its `url` field (see "Rewritten-input shape" below). Copy-on-write: the caller's original object is never mutated.
- `uploads` — one upload record per prepared asset (the `uploadFile` record shape), exposing `uri` so callers can log which source became which reference without reverse-engineering the rewritten object.

The prepared `inputs` are passed to the existing run lifecycle unchanged.

## Signature-driven asset identification

The SDK **must not** guess that every string resembling a path is an asset — that would make ordinary text inputs environment-dependent and could upload unintended files. Interpretation comes from the method's **declared signature**, never from a value's shape alone. This mirrors the runtime's own top-down interpretation (`InputShaper`) combined with the file-reference resolution of `input_normalizer` in `pipelex`, so local and hosted execution read the same compact inputs the same way.

The declared signature is resolved via the explicit inputs template (`buildInputs` with `explicit: true` — see [build-routes.md](./build-routes.md)), which carries concept identity, canonical content shape, and multiplicity per input.

Interpretation per declared input:

- A bare string, path object, or byte-backed value at an **Image/Document-declared** input is a **file reference**: local paths, data URLs, and bytes are uploaded and rewritten to `pipelex-storage://` URIs; HTTP(S) URLs and existing `pipelex-storage://` URIs pass through unchanged.
- The **identical** bare string at a **Text-declared** input is text and is never touched.
- **Canonical image/document content structures** are recognized by their URL-bearing fields wherever they appear, including nested in structured objects and lists — exactly as the runtime normalizer walks them. The refining case matters: a concept refining `Image`/`PDF` is classified by the **canonical content shape**, not by the concept ref alone.
- Inputs declared **`Dynamic`** are not path-interpreted (the signature genuinely cannot guide them); they accept canonical content structures or already-prepared references only.
- A repeated reference to the **same source** within one preparation is uploaded once and rewritten consistently (within-preparation dedup by source identity).

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

The contract distinguishes at least these semantic outcomes (exact typed error classes are settled during implementation):

- **invalid local source** — missing, unreadable, or a path string outside Node;
- **rejected asset** — the server refused it (e.g. a `413` past the service-defined size cap — see "Storage policy" — surfaced as a clear rejection, not a raw transport error);
- **unsupported server capability** — the configured deployment has no upload route;
- **authentication / authorization failure** — `401` / `403`;
- **transport failure** — network / server fault.

All preparation failures are raised **before any run is created**.

## Storage policy (inherited, Phase 1)

The SDK ships against **today's route behavior**: a service-defined size cap (hosted default 50 MiB via `MAX_UPLOAD_MIB`, rejected with `413`), auth required, per-user keys, and nothing else — no MIME validation, retention, quotas, dedup, or cleanup. The SDK documents limits as **service-defined** and surfaces server rejections as clear "rejected asset" errors; it does **not** hardcode a client-side cap. Real storage policy (retention, quotas, org scoping, cleanup) is a later hosted-owner deliverable.

## Stability across the future endpoint move

The public abstraction sits deliberately **above** the HTTP route. Callers depend on `uploadFile` / `prepareInputs`, the `uri` result field, and the `pipelex-storage://` scheme — never on which backend service owns the route. The current transport is `POST /v1/upload` on `pipelex-api`; when hosted storage upload later moves to `pipelex-platform` (together with its paired resolution route, as one storage domain), the public path and wire shape are kept compatible so released SDK versions keep working, and any wire-protocol change is absorbed inside the SDK's upload transport. `uploadFile`, `prepareInputs`, and the prepared run-input shape stay stable across that move.

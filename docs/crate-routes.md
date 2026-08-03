# Crate routes (`/v1/resolve`, `/v1/codegen`)

Two routes project a **closure** of MTHDS files into the artifacts downstream tooling actually consumes: `resolve` emits the **normalized library crate**, and `codegen` projects that crate into **stamped typed artifacts** plus their lock. Like the [build routes](./build-routes.md), they are Pipelex API extensions rather than MTHDS Protocol operations — but note the ownership split: the _crate_ is standard-owned (the MTHDS Library Crate Format), while the HTTP surface serving it, and every type projection on top of it, are ours.

## The shared envelope

Both take the same closure selector — inline `files` **or** a `method_ref`, exactly one:

```ts
interface CrateRequestBase {
  files?: MthdsFileItem[]; // [{ content, source? }] — `source` is the provenance label
  method_ref?: string; // reserved — the registry does not exist yet, so the server answers 501
}
```

This is the same `MthdsFileItem` and the same `source` semantics the build routes use, so the [notes there](./build-routes.md#the-shared-envelope) apply verbatim: pass a filename per file and, when the engine can attribute a diagnostic to one, it comes back as `source` on the corresponding `validation_errors[]` item.

Supplying **neither** selector or **both** is a request-shape `422`. The SDK does not model that XOR in the type system — the union would force the overwhelmingly common `{ files }` call site to pick a branch for no gain, and the server's answer is a typed `ApiResponseError` either way.

There is no `method_id` sugar here (unlike `buildInputs`). To work from a stored method, expand it first — one line, and it is exactly what the sugar would do internally:

```ts
const crate = await client.resolve({ files: await client.getMethodClosure(methodId) });
```

## `resolve` — the normalized crate

Resolution is a first-class language operation alongside validation: the closure is loaded and statically validated, then emitted with fully qualified refs, refinement flattened, natives materialized, and a fingerprint set.

```ts
const result = await client.resolve({ files: [{ content: src, source: "method.mthds" }] });

if (!result.is_valid) {
  for (const err of result.validation_errors) console.error(`${err.source ?? "?"}: ${err.message}`);
  return;
}

console.log(result.crate.fingerprint); // rides INSIDE the crate, not beside it
```

Two things to internalize:

- **`fingerprint` and `mthds_version` are crate members**, not siblings of `crate`. The payload is the canonical JSON encoding — the same bytes `pipelex resolve --format json` prints — so a fingerprint computed from either surface agrees.
- **`crate` is typed as opaque transport** (`Record<string, unknown>`). Its schema belongs to the MTHDS standard; restating it here would be a second source of truth, free to drift from the one the server emits.

`resolve` runs **no dry-run sweep**. A valid verdict says the library resolves, never that it runs — runnability is `validate`'s vocabulary.

## `codegen` — stamped artifacts and the trust chain

`codegen` resolves the same way, then projects the crate through **two explicit axes**:

| Axis     | Values                                                  | Notes                                                          |
| -------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `kind`   | `types`                                                 | The crate's whole concept set. Per-pipe kinds are future work.  |
| `target` | `ts-zod`, `python-pydantic`, `python-structures`         | `ts-zod` is the natural one for TypeScript consumers.           |

```ts
const result = await client.codegen({ files, kind: "types", target: "ts-zod" });
if (!result.is_valid) return;

for (const artifact of result.artifacts) await writeFile(artifact.path, artifact.content);
await writeFile(result.lock_filename, result.lock); // "codegen.lock", beside the artifacts
```

**The trust chain is the reason the lock rides along.** Write every artifact at its `path` and the `lock` content as `lock_filename`, both **verbatim**, and the resulting tree is byte-identical to what a local `pipelex codegen types` run produces — same stamps, same lock — so the offline `pipelex codegen check` passes on it. Reformatting an artifact, or re-serializing the lock through your own TOML writer, breaks that chain. There is deliberately **no** server-side check route: the check is offline by design.

`crate_fingerprint` and `engine_version` say what the artifacts were generated _from_ — the crate `resolve` would have returned for the same closure, and the pipelex engine that emitted them.

The SDK stays transport-only: it hands you the artifacts and does not write files for you.

### `pipe_ref` is rejected, not ignored

`kind: "types"` is concept-set-wide, so passing `pipe_ref` alongside it is a request-shape **`422`**. Silently ignoring the selector would mislead a caller into believing the artifacts were narrowed to one pipe. The field exists on the request for the future per-pipe kinds.

## The response is a verdict, not a payload

Both routes return a **discriminated 200**, the same discipline as `validate` and the build routes: an unresolvable closure is the _successful product_ of the call (the request was well-formed; the library was not), so it rides a 200 with `is_valid: false` and the shared `CrateInvalidReport` — the very same invalid arm the build routes return, carrying the same structured `validation_errors[]`.

**Branch on `is_valid` before reading the arm.** A consumer that only catches throws will render a success over an unusable result, because nothing threw.

## What throws

Only a **no-verdict** condition, as the typed `ApiResponseError` — branch on its `status`, never on its message:

| Status        | Cause                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `422`         | Request shape: neither or both closure selectors, an unknown `kind`/`target`, a `pipe_ref` on `kind: "types"`. |
| `501`         | `method_ref` — reserved, not implemented.                                                                   |
| `401` / `403` | Auth.                                                                                                       |
| `5xx`         | Server fault.                                                                                               |

Note the split, same as the build routes: a bad **closure** is a 200 verdict; a bad **request** throws.

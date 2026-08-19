# Crate routes (`/v1/resolve`, `/v1/codegen`)

Two routes project a **closure** of MTHDS files into the artifacts downstream tooling actually consumes: `resolve` emits the **normalized library crate**, and `codegen` projects that crate into **stamped typed artifacts** plus their lock. Like the [build routes](./build-routes.md), they are Pipelex API extensions rather than MTHDS Protocol operations — but note the ownership split: the _crate_ is standard-owned (the MTHDS Library Crate Format), while the HTTP surface serving it, and every type projection on top of it, are ours.

> **Hosted exposure is partial: `api-dev.pipelex.com` yes, `api.pipelex.com` not yet.** Any `pipelex-api` runner serves these routes. Reaching them on the hosted plane additionally requires that the gateway's API-key allowlist and the platform's tooling proxy list the path — both enumerate routes explicitly — and an unlisted path answers a gateway `403 {"message":"Forbidden"}`, refused before any service sees the request, so not even an RFC 7807 problem body.
>
> Measured 2026-08-19, same API key, same run (first confirmed 2026-08-13 on dev's `0.2.8`; re-verified since on `0.9.0`, so the exposure survived a redeploy):
>
> | Origin | `resolve` / `codegen` |
> | --- | --- |
> | `api-dev.pipelex.com` (`pipelex-hosted@0.9.0`) | **Available** — all three targets, and the full verdict discipline below survives the gateway intact (a `200` `is_valid: false`, the `501`, and the `422` all arrive as documented) |
> | `api.pipelex.com` (`pipelex-hosted@0.2.6`) | `403` — waiting on the deploy, not on a further code change |
>
> **`lint` / `format` are still `403` on both origins** — only the crate routes were allowlisted. Use a runner for those. Tracked in [`wip/hosted-exposure-crate-and-tools-routes.md`](../wip/hosted-exposure-crate-and-tools-routes.md).

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
const result = await client.resolve({ files: await client.getMethodClosure(methodId) });
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

- **`fingerprint` and `mthds_version` are crate members**, not siblings of `crate`.
- **Compare `fingerprint` values; never hash the crate yourself.** The fingerprint is a property of the _logical_ crate, not of an encoding: the server hashes `{concepts, pipes, domains}` with provenance `source` stripped, excluding `source_map`, `mthds_version` and `fingerprint` itself. And these are not the bytes `pipelex resolve --format json` prints — the CLI pretty-prints, the route answers compact JSON. Same logical crate, different serialization. Hashing `JSON.stringify(result.crate)` and comparing it against `result.crate.fingerprint` will mismatch on every call, and will look like tampering.
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

The SDK stays transport-only: it hands you the artifacts and does not write files for you. Verifying a committed tree later is the other half of the chain, and that half needs no server at all — see [the offline check](#the-offline-check--runcodegencheck) below.

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

(The offline check below is not a route and throws its own `CodegenLockError` instead — it never reaches the network.)

## The offline check — `runCodegenCheck`

A consumer that commits the generated tree needs a CI gate over it. That gate is `runCodegenCheck`, and it is **pure**: no filesystem, no network, no API key, no `PipelexApiClient`. You walk your own tree and hand in the text; the SDK owns the verdict.

The reason it is a separate, engine-free step is the same reason there is no server-side check route. Regeneration is a **dev action** — it needs the engine, so it is `codegen` above. The check is a **CI action** — it needs only a hash function. Keeping them apart is what stops an upstream template improvement from reddening a consumer's CI on a tree nobody touched.

```ts
import { isStampableArtifactPath, runCodegenCheck } from "@pipelex/sdk";

const report = await runCodegenCheck({
  lockContent: await readFile("src/generated/echo/codegen.lock", "utf8"),
  // Every file under the lock's directory, recursively, with paths relative to it.
  files: await readTree("src/generated/echo", isStampableArtifactPath),
});

if (!report.isCurrent) {
  for (const drift of report.drifts) {
    console.error(`${drift.category}: ${drift.path} — ${drift.detail}`);
  }
  process.exit(1);
}
```

A `codegen()` response feeds straight in with no mapping — `GeneratedArtifact` and `CodegenTreeFile` are structurally identical on purpose, so `runCodegenCheck({ lockContent: result.lock, files: result.artifacts })` type-checks and reports `isCurrent`. That is worth doing right after a regeneration, before writing anything to disk.

The function is `async` because it hashes through **WebCrypto** (`crypto.subtle`) rather than `node:crypto`, so the check adds no Node builtin to the barrel's import graph. (That is not the same as the barrel being browser-bundleable today: `upload.ts` still names `node:fs/promises`, so a browser-targeting bundler must mark `node:*` external.) One caveat that never bites a CI script but should not surprise anyone: `crypto.subtle` is secure-context-only, so a browser page must be served over https (or localhost).

### The algorithm

Each locked artifact is located in the supplied tree and the hash of the body **below its stamp** is recomputed. Absent is a drift; a body that no longer hashes to what the stamp or the lock records is a drift. Then, in the other direction, a stamped file the lock does not track is a drift — the stale-artifact class a per-file stamp can never catch on its own, and the reason the lock rides along with the artifacts at all.

The verdict is a structured report, never an exit code alone: `drifts` enumerates the drifting artifacts by category, and `isCurrent` is exactly `drifts.length === 0`. Drift order is deterministic — locked-artifact drifts first, then orphans, each sorted by path — so a consumer can print it, snapshot it, or diff two runs.

The report also carries `crateFingerprint` and `engineVersion`, read off the lock header. The check itself never compares them against anything (that would need the engine), but surfacing them is what lets a caller ask the question the check deliberately does not: _is this committed tree even from the crate my method resolves to today?_ — a live `codegen()` response's `crate_fingerprint` is the value to compare against.

### The drift taxonomy

| Category      | What it means                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `missing`     | Listed in the lock, absent from the tree you handed in.                                               |
| `modified`    | Present, stamp self-consistent, but the body no longer matches the **locked** hash — regenerate.      |
| `hand-edited` | Present, but its stamp is gone, unparseable, or disagrees with the body below it — someone edited it. |
| `orphan`      | A stamped file the lock does not track — yesterday's artifact, left behind. Remove or regenerate.     |

Two properties of that table are load-bearing and are pinned by tests:

- **At most one drift per locked path, and `hand-edited` outranks `modified`.** A hand edit trips both conditions; reporting it twice would print the same file under two contradictory categories.
- **An orphan only has to _look_ stamped.** A stray whose stamp is corrupt below the begin-marker line still counts — using the stricter parse there would silently ignore exactly the stale file the lock exists to catch.

The category values are the canonical strings `pipelex codegen check` uses, and so are the `detail` sentences, verbatim. A consumer switching between the CLI and this helper reads the same report.

### Where it knowingly differs from the CLI

Verdict parity is the design constraint, and the stamp-header text rules mirror Python's exactly — the line-boundary set, the strip set, and the drive-prefix rule are all matched deliberately, each pinned by a test. Two differences remain on purpose:

- **The projection line is shape-checked, not vocabulary-checked.** pipelex resolves `kind` and `target` against its own enums, which cannot lag its own emitter; an SDK copy can. So a stamp reading `projection: types / rust-serde` from a newer engine verifies here and would be `hand-edited` there. Tightening it would report every artifact of such a tree as a hand edit — the failure mode is worse than the gap, and it is pinned in both directions.
- **The "not valid UTF-8" branch cannot arise.** `content` reaches the check already decoded, so the caller owns that verdict — see the decode obligation above.

### The caller's obligations

The pure input moves the tree-reading obligations onto you. Each one, unmet, produces a **wrong verdict** rather than an error — so none of them can be left implicit:

- **Pass each file's text as read, without reformatting it.** The hash is over exact UTF-8 bytes, and the stamp parser requires the text to _start with_ the begin-marker line. Re-encoding, inserting a BOM, or running Prettier over a generated artifact all report `hand-edited`.
- **Line endings are the one exception, and they are handled for you.** `\r\n` and lone `\r` are normalized to `\n` before anything is parsed or hashed, mirroring the universal-newline translation pipelex's own reader applies. A Windows checkout under `core.autocrlf=true` is therefore **not** a false hand-edit here, exactly as it is not one for the CLI. Committing generated artifacts with a `.gitattributes` entry (`src/generated/** -text`) is still worth doing for diff hygiene; it is not load-bearing for the verdict.
- **Walk the whole tree, recursively, from the lock's directory**, and pass paths relative to it. An incomplete list yields a wrong verdict in either direction: an omitted _locked_ file is reported `missing` though it sits on disk, and an omitted _orphan_ is never seen at all — `isCurrent: true`, a false negative on precisely the drift class orphan detection exists for. Filter your walk with `isStampableArtifactPath` (or `STAMPABLE_ARTIFACT_SUFFIXES`) so it picks up exactly what the check considers; a file of any other type is skipped rather than rejected, which is what lets you park a sidecar such as `sources.json` beside the lock. Pruning vendor and VCS directories and skipping symlinks is walk policy and stays with you — moot for a per-method generated directory, which holds nothing else.
- **Decode the bytes yourself.** `content` is already a `string`, so pipelex's "not valid UTF-8, therefore not generated output" branch cannot arise here. A file you could not decode is not generated output: report it yourself, or leave it out and accept the `missing` drift.

### What it deliberately does not verify

It never compares a stamp's `crate_fingerprint` against the lock's, and it never re-resolves the crate. Both need the engine, which is the whole point of the offline split — and both are questions the caller can ask itself with `crateFingerprint` in hand.

### What the check throws

`CodegenLockError`, and only for a **no-verdict** condition: a malformed lock, an unknown key in it, or a path — in the lock or in your `files` — that is not a safe canonical artifact path (absolute, drive-prefixed, backslashed, control-charactered, `..`-bearing, empty, duplicated, or, for a locked path, of a type codegen does not stamp). None of these is a drift: the check could not produce a verdict at all, which is a distinct outcome and typically a distinct exit code. It deliberately does not derive from `PipelineRequestError` — nothing was requested over the wire.

A `"./types.ts"` spelling is worth calling out, because it is the one a hand-rolled walk produces by accident: left to resolve as-is it would report both a `missing` and an `orphan` for the same file, so it throws instead.

# Build routes (`/v1/build/*`)

The three build projections — `buildInputs`, `buildOutput`, `buildRunner` — take a **closure** of MTHDS files, select **one pipe** in it, and project something from that pipe. They are Pipelex API extensions, not MTHDS Protocol routes: the standard specifies no projection surface, so these are ours to shape.

## The shared envelope

Every build request supplies the closure **either** as inline `files` **or** as a `method_ref` into the method registry — never both:

```ts
interface MthdsFileItem {
  content: string;
  source?: string; // provenance label — threaded onto this file's diagnostics
}

interface CrateRequestBase {
  files?: MthdsFileItem[];
  method_ref?: string; // reserved — the registry does not exist yet, so the server answers 501
}

interface BuildRequestBase extends CrateRequestBase {
  pipe_ref?: string; // QUALIFIED `domain.pipe_code`; omit to default to the closure's `main_pipe`
}
```

The selector half is `CrateRequestBase`, shared verbatim with the [crate routes](./crate-routes.md) (`resolve` / `codegen`) — the same split the server makes (`MthdsPipeRequest(MthdsFilesRequest)`). What the build routes add is the pipe selector.

`source` is why the envelope exists. A closure is a set of files, and a diagnostic that cannot say _which_ file it came from is much harder to act on. Pass a filename (or any label) per file and, **when the engine can attribute the diagnostic to a file**, it comes back as `source` on the corresponding `validation_errors[]` item.

Treat that attribution as best-effort, not a guarantee — which is why `ValidationErrorItem.source` is typed optional and why the sample below reads `err.source ?? "?"`. Some arms don't populate it: graph-level `dry_run` and `pipe_factory` items have no single owning file, and a `main_pipe` naming a nonexistent pipe currently reports its provenance in the message prose while leaving the structured field unset. The syntax-error arm, the common case, does thread it.

`pipe_ref` is **qualified** — `smoke.echo`, not `echo`. Omitting it defaults to the closure's declared `main_pipe`, which fails with a `422` when the closure declares **none**, or declares **several** across its domains. When you already know the pipe, name it: it is one field, and it removes the whole default-resolution failure mode.

> `MthdsFileItem` is not the same type as `MthdsFile` (the one `validateFiles()` takes). `/v1/validate` spells the provenance label `uri` and carries it in a parallel `mthds_sources` array; this envelope spells it `source` and carries it inline. The two collapse into one only if `/v1/validate` ever migrates onto `files[]` — a protocol-level change owned by the MTHDS standard, not ours to make here.

## The response is a verdict, not a payload

Each route returns a **discriminated 200**, following `validate`'s discipline: an unresolvable closure is the _successful product_ of the call (the request was well-formed; the library was not), so it rides a 200 with `is_valid: false`, never a 4xx.

**Branch on `is_valid` before reading the arm.** This is the easy thing to get wrong — a consumer that only catches throws will render a success over an unusable result, because nothing threw:

```ts
const result = await client.buildInputs({ files: [{ content: src, source: "method.mthds" }] });

if (!result.is_valid) {
  // 200, but the closure did not resolve. `validation_errors[]` says why, and each
  // item's `source` names the file it came from.
  for (const err of result.validation_errors) {
    console.error(`${err.source ?? "?"}: ${err.message}`);
  }
  return;
}

// Narrowed to the valid arm.
console.log(result.pipe_ref); // the RESOLVED qualified ref, e.g. "smoke.echo"
console.log(result.inputs); // the template
```

The valid arm always echoes two refs: `pipe_ref` is what the server **resolved** (always qualified), and `requested_pipe_ref` is what you **submitted** — absent entirely when you omitted it and the server defaulted to `main_pipe`.

## What throws

Only a **no-verdict** condition, and it throws the typed `ApiResponseError` — branch on its `status`, never on its message:

| Status        | Cause                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `422`         | The pipe selector does not resolve: an unknown `pipe_ref`, or an omitted one on a closure with no `main_pipe` — or several. Also an output concept that cannot be rendered (`buildOutput`), and a requested pipe the dry-run skipped (`buildRunner`). |
| `501`         | `method_ref` — reserved, not implemented.                                                                                                                                                                                                             |
| `401` / `403` | Auth.                                                                                                                                                                                                                                                 |
| `5xx`         | Server fault.                                                                                                                                                                                                                                         |

Note the split: a bad **closure** is a 200 verdict; a bad **request** throws. "Your `pipe_ref` names nothing in this closure" says nothing is wrong with the closure — you asked for a pipe that isn't there — so it is a request error.

## The payload field follows `format`

Both `buildInputs` and `buildOutput` carry their payload in **one of two fields**, chosen by the requested `format`. The field the format did not select is **absent** from the body, not `null`.

| Route         | `format`                     | Field           | Type                      |
| ------------- | ---------------------------- | --------------- | ------------------------- |
| `buildInputs` | `json` _(default)_           | `inputs`        | `Record<string, unknown>` |
| `buildInputs` | `toml`                       | `inputs_toml`   | `string`                  |
| `buildOutput` | `schema` _(default)_, `json` | `output`        | `Record<string, unknown>` |
| `buildOutput` | `python`                     | `output_python` | `string`                  |

The split is deliberate, not an accident of serialization. TOML cannot ride as a parsed object without losing exactly what makes it worth asking for — its concept comments and key order — and Python source is text by nature. Collapsing either into the JSON case would have meant stringifying the object case too, and the object shape is what consumers actually want.

`buildInputs` also takes `explicit` (default `false`), which emits the ceremonial `{concept, content}` envelope per input instead of the light shape.

## `buildRunner` is the odd one out

It is the only build route that still **dry-runs** the closure, so:

- It keeps `allow_signatures` (accept unresolved pipe signatures as pending rather than invalid). The other two dropped it — the flag only ever parameterized the sweep, and they no longer sweep.
- Its valid arm carries `python_code` plus a stamped `structures` projection (`directory`, `artifacts[]`, `lock`, `lock_filename`) — write the artifacts and the lock under `directory`, relative to the runner script, and the script runs against them.
- **Omitting `pipe_ref` sweeps the WHOLE closure**, not just the pipe it defaults to. The default can only be resolved _after_ the sweep has run, so there is no way to scope it in advance. A broken _sibling_ pipe can therefore sink the request — which is the honest answer for a caller who did not say which pipe they meant. Pass `pipe_ref` to scope the sweep.

`buildInputs` and `buildOutput` are **static**: they read the pipe's _declared_ IO off a resolved crate. A valid verdict from them says the closure is structurally sound — never that the pipe runs. Runnability is `validate`'s vocabulary, and `buildRunner`'s.

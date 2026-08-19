# Deferred — by-id (`method_id`) sugar on `resolve()` / `codegen()`

**Status:** deferred at Checkpoint 1 of the crate-routes change (`resolve()` + `codegen()` on `PipelexApiClient`). Not a known bug; a deliberate scope decision to revisit if a consumer asks.

## What was considered

`buildInputs` accepts a third closure source beside the wire model's `files` / `method_ref`: a client-side `method_id`, resolved to `files` via `getMethodClosure` before the request hits the wire (`BuildInputsByMethodId` in `src/client.ts`, `resolveFilesOrMethodId` in `src/prepare-inputs.ts`). The same sugar could ride `resolve()` and `codegen()`:

```ts
await client.codegen({ method_id: "mt_1", kind: "types", target: "ts-zod" });
```

## Why it was deferred

- **The workaround is one line, and it is the same call the sugar would make internally:**
  ```ts
  await client.codegen({ files: await client.getMethodClosure(methodId), kind: "types", target: "ts-zod" });
  ```
  It is documented in the `resolve()` TSDoc.
- **`buildInputs` has it for a reason this change does not share.** `prepareInputs` needs a by-id path internally, so the resolution helper existed already and `buildInputs` surfaced it. Nothing in the crate routes needs it.
- **The cost is not the resolution call.** It is a second exported param type per method (`ResolveByMethodId`, `CodegenByMethodId`), the `method_id?: never` pins on the wire request types, a runtime guard for untyped JS callers, and the tests that pin all of it — for two routes, doubling the request surface.

## What would change the answer

A consumer (the webapp is the likely one) generating `ts-zod` types for a **stored** method often enough that the `getMethodClosure` hop is noise at the call site. At that point add it to both methods at once, reusing `resolveFilesOrMethodId` so the files/method_id invariant stays defined in exactly one place, and mirror `buildInputs`'s "`method_ref` cannot combine with `method_id`" guard.

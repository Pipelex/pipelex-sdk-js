# Handoff — method-id closure resolution (`@pipelex/sdk` v0.6.0)

**For:** the agent working `../pipelex-sdk-js`.
**Why now:** `pipelex-mcp` is about to build its input-preparation tool (`mthds_prepare_inputs`) over `prepareInputs`, and wants by-id (catalog `method_id`) support to be *elegant* — resolved in the SDK, not re-plumbed per consumer. This is the deferred-and-additive item the v0.5.0 changelog already named ("`prepareInputs` takes the method closure as inline `files`; catalog `method_id` resolution … deferred and additive"). Do this **before** the MCP resumes, so the MCP tool is by-id-capable from day one.

## The gap

`prepareInputs({ files, pipe_ref?, inputs })` (`src/prepare-inputs.ts:26`) and `buildInputs(request)` (`src/client.ts:708`) both require the method **closure** as inline `files: MthdsFileItem[]` — they have no way to take a registered method's catalog id. The SDK already has `getMethod(methodId): Promise<MethodData>` (`src/client.ts:914`) and `MethodData.mthds: string` (`src/product-models.ts:31`), but **no parser** that turns that polymorphic stored source into runnable file contents. So a consumer holding only a `method_id` cannot prepare inputs through the SDK.

## The canonical parser (the headline deliverable)

`MethodData.mthds` is polymorphic: raw `.mthds` source, or a JSON-serialized `[{ name, content }, …]` file array (the webapp editor format), or empty. The canonical parser lives in **pipelex-platform's `routers/v1/execution.py`** as `_method_source_to_contents` + the blank-source guard in `_resolve_method_contents`. It is currently mirrored in TypeScript in **pipelex-mcp's `src/capabilities/method-source.ts`** — a proven, tested implementation. **Lift that into the SDK as the canonical TS copy**, so pipelex-mcp can then retire its mirror. The whole function (port verbatim, keep the doc comment that pins it to `execution.py`):

```ts
/** Parse a stored MethodData.mthds source into bundle file contents.
 *  Mirrors pipelex-platform's execution.py (_method_source_to_contents +
 *  _resolve_method_contents blank guard) — keep the two in sync.
 *  [] means the stored method has no MTHDS source. */
export function methodSourceToContents(mthds: string): string[] {
  if (!mthds) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(mthds); } catch { return rawBundle(mthds); }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return [];
    if (parsed.every(isFileEntry)) {
      return parsed
        .map((e) => e.content)
        .filter((c): c is string => typeof c === "string" && c.trim() !== "");
    }
  }
  return rawBundle(mthds);
}
function rawBundle(mthds: string): string[] { return mthds.trim() === "" ? [] : [mthds]; }
function isFileEntry(e: unknown): e is { name: unknown; content: unknown } {
  return typeof e === "object" && e !== null && "name" in e && "content" in e;
}
```

Note the one deliberate divergence documented in the MCP source: the platform's blank guard is a falsy check (`if method.mthds`), so a whitespace-only raw source passes there and fails downstream at parse; the TS version trims to "no source" — a clearer verdict for the same degenerate input. Preserve that.

Because the source model is a **platform** concept (stored `MethodData`), the SDK is the right canonical home (it owns the product surface). Keep field names neutral — no re-branding.

## The deliverable

1. **Export `methodSourceToContents(mthds: string): string[]`** — the pure parser above, from the barrel (`src/index.ts`). Port the MCP's tests alongside it.
2. **Add a fetch+parse convenience on the client**, e.g. `getMethodClosure(methodId: string): Promise<MthdsFileItem[]>` = `getMethod` → `methodSourceToContents` → `MthdsFileItem[]` (each item's `source` labelled with the method id for provenance). An empty parse result (stored method has no MTHDS source) must surface as a **distinct typed error** (a new `EmptyMethodSourceError`, or a documented member of the existing error family) so consumers can classify "no source yet" separately from a transport failure — the MCP renders it as a specific no-verdict today.
3. **Let `prepareInputs` and `buildInputs` accept `method_id` as an alternative to inline `files`** (an either/or: one of `files` | `method_id` required). When `method_id` is given, resolve the closure via (2) internally, then proceed exactly as today. Preserve current behavior when `files` is given. Document that by-id requires an API key (the catalog is org-scoped to the key's org — a `getMethod` 404 covers unknown *and* foreign-org ids).

## Acceptance

- `methodSourceToContents` exported + unit-tested for every source shape (raw / JSON file-array / JSON `[]` / non-array JSON / unparseable / blank / whitespace-only).
- `prepareInputs({ method_id, inputs })` and `buildInputs({ method_id, … })` resolve a stored method and produce the same result as the equivalent inline-`files` call.
- Empty-source and unknown-id paths raise typed, documented errors.
- `docs/input-preparation.md` updated (drop the "`method_id` resolution deferred" caveat); CHANGELOG entry under a new `## [v0.6.0]`.

## Out of scope

- Opt-in `http(s)` → storage ingest (still pass-through; separately deferred).
- Native `method_id` on the runner's `/v1/build/inputs` and `/v1/validate` **routes** — that is the deeper platform-side fix (a separate handoff to the platform team). This SDK helper is the client-side intermediate; design it so it can later delegate to a native route without changing the consumer-facing signature.

## Downstream once this ships

`pipelex-mcp` bumps `@pipelex/sdk` to `^0.6.0`, then: builds `mthds_prepare_inputs` passing `method_id` straight through (no throwaway fetch-and-forward leg), and **retires `src/capabilities/method-source.ts`**, calling the SDK's canonical parser/closure helper from its existing by-id legs (`mthds_validate`, `mthds_inputs_template`) too — collapsing the duplicated parser to one copy.

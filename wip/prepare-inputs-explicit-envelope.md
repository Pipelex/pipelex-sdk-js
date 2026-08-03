# Handoff: `prepareInputs` chokes on the explicit `{concept, content}` envelope its own template produces

**Filed:** 2026-07-24, from the `pipelex-mcp` side (branch `feature/Use-new-sdk-for-uploads`, PR [Pipelex/pipelex-mcp#15](https://github.com/Pipelex/pipelex-mcp/pull/15)).
**Found by:** a Codex review comment on that PR ("Handle explicit input envelopes in hosted prepare"), then reproduced and root-caused against `@pipelex/sdk@0.7.0`.
**Owner requested:** fix in `@pipelex/sdk` (`src/prepare-inputs.ts`), not worked around in the MCP.
**Status: READY / turnkey (re-verified against SDK 0.8.0 `dev`).** All code references below are exact against the current source; the one open question (does `/v1/start` accept the envelope?) is **resolved** by reading the `pipelex` runtime — see the ✅ RESOLVED section. The decision is settled: **Option A, re-wrap on output.** No open questions remain; an implementer can code straight from the recommended snippet + acceptance criteria.

## TL;DR

`prepareInputs` walks the pipe signature's **compact** content shape against the caller's `inputs`. But an agent that fills the **explicit** template — the `{ concept, content }` envelope that `buildInputs({ explicit: true })` returns, and which is now the *default* template shape the MCP hands agents — submits envelope-shaped values. At every file-bearing position the walk fails to recognize the envelope and throws:

```
InputPreparationError: Unsupported value at a file input: expected a path string, bytes …, a data URL,
an http(s)/pipelex-storage:// URL, or canonical {url} content; got object.
```

So the SDK's own explicit template cannot be round-tripped back into the SDK's own `prepareInputs`. Compact inputs work; explicit-envelope inputs don't. The natural agent flow `buildInputs(explicit) → fill → prepareInputs` is broken for any input carrying a file.

## Why this surfaced now

The MCP just made `mthds_inputs_template`'s `explicit` **default to `true`** (ceremonial `{concept, content}` per input — the shape an agent needs to fill correctly), and shipped a new `mthds_prepare_inputs` tool over the SDK's `prepareInputs`, in the same unreleased set. The documented flow is: `mthds_inputs_template` (explicit by default) → agent fills → `mthds_prepare_inputs` → `mthds_run`. Steps 1 and 3 now disagree on the input shape. Before the default flip, agents that happened to submit compact values dodged it.

## Minimal reproduction (pure SDK, no MCP, no network)

A fake `PrepareCapableClient` whose `buildInputs` returns an explicit template with one file input (`photo`) and one text input (`question`). Feeding it the **filled explicit template** throws; feeding it the **compact** equivalent succeeds. `buildInputs` never touches the network here; `upload` is never reached because the walk throws first.

```ts
import { prepareInputs } from "@pipelex/sdk"; // or ./src/prepare-inputs.js in-repo

const client = {
  async buildInputs() {
    return {
      is_valid: true,
      pipe_ref: "demo.main",
      message: "ok",
      format: "json",
      explicit: true,
      inputs: {
        photo: { concept: "native.Image", content: { url: "https://example.com/placeholder.png" } },
        question: { concept: "native.Text", content: "Your question here" },
      },
    };
  },
  async getMethodClosure() { throw new Error("unused"); },
  async upload() { throw new Error("upload must not be reached"); },
} as any;

const files = [{ source: "bundle.mthds", content: "domain = 'demo'" }];

// ❌ THROWS — the agent filled the DEFAULT (explicit) template in place:
await prepareInputs(client, {
  files,
  inputs: {
    photo: { concept: "native.Image", content: { url: "https://example.com/real.png" } },
    question: { concept: "native.Text", content: "What is in the photo?" },
  },
});
// InputPreparationError: Unsupported value at a file input … got object.

// ✅ WORKS — the compact shape the SDK docs assume:
await prepareInputs(client, {
  files,
  inputs: { photo: "https://example.com/real.png", question: "What is in the photo?" },
});
// → { inputs: { photo: { url: "https://example.com/real.png" }, question: "…" }, uploads: [] }
```

(Verified equivalently through the MCP's console pass-through path, which is a faithful line-for-line mirror of this walk — same failure, reported as an `input_domain` refusal at `inputs`. The workshop path delegates straight to `prepareInputs` and throws the SDK error above.)

## Root cause — `src/prepare-inputs.ts`

The top-level loop (≈ line 311) unwraps the **template** entry's `.content`, then walks it against the **raw** caller value:

```ts
for (const [name, callerValue] of Object.entries(request.inputs)) {
  const entry = template[name];                       // { concept, content: <compact content> }
  if (!isPlainObject(entry) || !("content" in entry)) continue;
  rewritten[name] = await resolveNode(ctx, entry.content, callerValue); // ← templateNode = compact content
}
```

- For a file input, `entry.content` is `{ url: "…" }` → `isFileContent(templateNode) === true` → `resolveFilePosition(callerValue)` (line ~179).
- When `callerValue` is the **compact** value (`"https://…"` or `{ url: "…" }`), `resolveFilePosition` handles it: bare source or `isFileContent` → resolves the url. ✅
- When `callerValue` is the **explicit envelope** `{ concept, content: { url } }`, it is *not* `isFileContent` (no top-level `url` key), so `resolveFilePosition` treats the whole object as a source → `doResolveSource` (line ~149) sees a non-string, non-bytes value → throws "Unsupported value at a file input". ❌

Note neither obvious one-liner fixes both shapes:
- Walking `entry.content` (compact) against the caller value → breaks the **envelope** caller (above).
- Walking the whole `entry` (envelope) against the caller value → then the **compact** caller (`"https://…"`) mismatches a plain-object template node at `resolveNode` line ~204 and passes through **unrewritten** — the url never becomes `{ url }`, silently wrong.

The walk must **detect and normalize the caller's shape**, not pick one template altitude.

## The design decision (SDK team owns this)

The SDK docs (`docs/input-preparation.md`) state `prepareInputs` "interprets the caller's **compact** inputs top-down against that signature." So today's contract is *compact-only*. Two coherent resolutions:

**Option A — accept both compact and explicit-envelope caller values (recommended).**
Make `prepareInputs` tolerant: when a caller value is an explicit envelope `{ concept, content }`, unwrap to `.content`, run the existing walk against it, then re-wrap. Concretely, in the top-level loop:

```ts
const isEnvelope = isPlainObject(callerValue) && "concept" in callerValue && "content" in callerValue;
const valueToWalk = isEnvelope ? (callerValue as { content: unknown }).content : callerValue;
const walked = await resolveNode(ctx, entry.content, valueToWalk);
rewritten[name] = isEnvelope ? { ...(callerValue as object), content: walked } : walked;
```

Rationale: the explicit template is a first-class output of `buildInputs({ explicit: true })`; an agent that fills what the SDK gave it should be able to hand it straight back. This keeps the round-trip closed and fixes every consumer (the MCP, `pipelex-app`, anything else) at once. It is the fix the MCP owner asked for.

**Option B — keep compact-only, reject the envelope with a precise, actionable error.**
If the intended contract is strictly compact, at least replace the generic "Unsupported value … got object" with a message that says "this looks like an explicit `{concept, content}` template envelope; submit the compact value (the inner `content`) instead," so consumers can guide the agent. This is weaker — it pushes envelope-stripping onto every consumer — but it's a valid stance if envelopes must never reach the wire.

**Recommendation: Option A.** It matches how agents actually use the template and removes a whole class of consumer-side workarounds.

### ✅ RESOLVED (2026-07-24): `/v1/start` accepts the explicit envelope → re-wrap on output

The previously-open question ("does the runtime accept the envelope, or compact-only?") is now **answered by reading the `pipelex` runtime**, so Option A's output shape is decided: **re-wrap the envelope** (the snippet above). Evidence:

- **`pipelex/pipelex/core/memory/input_shaper.py`** — `InputShaper` treats a dict whose keys are *exactly* `{"concept", "content"}` as a first-class **explicit form** (its D6 arm): `_is_explicit(value)` returns `true` for it and `shape()` dispatches to `_shape_explicit(...)`. The module docstring calls the `{"concept", "content"}` envelope a "compat-checked escape." So the runtime accepts the envelope as a run input — it is **not** compact-only.
- **`pipelex/pipelex/pipeline/input_normalizer.py`** — file-reference resolution (`data:` / local path / `pipelex-storage://` → storage URI, via `normalize_data_urls_to_storage`) runs over the **already-shaped `ImageContent` / `DocumentContent` in `WorkingMemory`**, *after* `InputShaper` has built them — it walks the shaped content wherever it appears (incl. nested in `ListContent` / `StructuredContent`), not the raw input dict. So url resolution is **envelope-agnostic**: a re-wrapped `{ concept, content: { url: "pipelex-storage://…" } }` shapes into the same `ImageContent(url=…)` a compact `{ url }` would, and resolves identically at run time.

**Consequences that firm up this whole handoff:**

1. **Output shape = re-wrap.** `prepareInputs` should preserve the envelope on output (`{ concept, content: <rewritten> }`), keeping the concept annotation end-to-end. The runtime accepts it, so there is no reason to strip it. (Normalize-to-compact would also *run*, but it discards the concept identity for no benefit.) The recommended snippet already does this.
2. **The "bigger blast radius" fear is CLEARED — the bug is scoped to `prepareInputs` alone.** Because the runtime accepts envelopes, the *skip-prepare* path (agent fills the explicit template with all-`http(s)`/`pipelex-storage://` inputs and calls `mthds_run` **without** prepare) already works end-to-end today. The explicit-default flip did **not** break the general run flow; it broke only `prepareInputs`, exactly as reported. No reconsideration of the MCP's explicit default is needed.
3. The `docs/input-preparation.md` "compact inputs" wording is a doc simplification, not a runtime restriction — update it to say both the compact and the explicit `{concept, content}` envelope are accepted (the envelope's `content` is interpreted exactly as the compact value would be).

(Verify path, if you want to re-confirm before coding: `input_shaper.py` `_is_explicit` / `shape` D6 arm; `input_normalizer.py` module docstring + `normalize_data_urls_to_storage` operating on `WorkingMemory`. Both are in the sibling `pipelex/` runtime repo.)

## Downstream obligations once the SDK ships the fix (MCP side — I'll handle these)

1. **Bump the MCP to the fixed SDK** and drop this from the release blockers. The MCP currently pins `^0.8.0` (checked: neither SDK 0.7.0 nor 0.8.0 touched `prepareInputs`); it'll move to whatever version carries the fix.
2. **Fix the console pass-through walk in parallel.** `pipelex-mcp/src/capabilities/prepare.ts` `preparePassThrough` is a deliberate line-for-line mirror of this SDK walk (minus upload), so it has the **identical** bug and must get the identical envelope-unwrap. Ideal end-state (already anticipated in the MCP SPEC's Prepare Inputs blockquote): the SDK exposes a small reusable file-position classifier / normalizer the console can call, instead of the MCP maintaining a hand-kept parity copy — same "SDK-canonical, swappable-for-native" posture as `getMethodClosure`. If you add such a helper, say so and the MCP will consume it.
3. **Reconcile the "compact" wording.** The MCP SPEC's `mthds_prepare_inputs.inputs` comment says "FILLED **compact** inputs (the `mthds_inputs_template` output, populated)" — internally inconsistent now that the template output is explicit-envelope by default. The MCP SPEC gets updated to say both compact and the explicit envelope are accepted.

## Acceptance criteria (SDK fix, Option A)

- `prepareInputs` accepts a filled **explicit** template (`{ concept, content }` per input) and a filled **compact** template, producing equivalent prepared inputs.
- File-bearing positions rewrite (upload / pass-through) identically regardless of which template shape the caller submitted.
- Text/scalar inputs are untouched in both shapes (no accidental upload of an envelope-wrapped string).
- Nested / multiplicity (list) file positions work under the envelope too — an envelope whose `content` is a list of file contents, or a structured content nesting file fields.
- Output preserves the envelope (`{ concept, content: <rewritten> }`) — decided above; `docs/input-preparation.md` updated to say both compact and the explicit envelope are accepted.
- Regression tests cover: compact file input, envelope file input, envelope text input (no upload), envelope list-of-images, mixed compact+envelope in one `inputs` object, and the existing pass-through / data-URL / local-path cases re-run under the envelope shape.

## Pointers

- SDK: `src/prepare-inputs.ts` — top-level loop ~line 311; `resolveNode` ~line 189; `resolveFilePosition` ~line 178; `isFileContent` ~line 89. Docs: `docs/input-preparation.md`.
- MCP mirror + release context: `pipelex-mcp/src/capabilities/prepare.ts` (`preparePassThrough`), `pipelex-mcp/SPEC.md` "Prepare Inputs Scope", `pipelex-mcp/TODOS.md` (Phase 2), PR #15.

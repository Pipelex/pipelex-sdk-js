# TODOS — `prepareInputs` must accept the explicit `{concept, content}` envelope

> **Archived — shipped in [v0.9.0](../CHANGELOG.md#v090---2026-07-24).** All phases below are complete; kept for historical context only.

**Goal:** make `prepareInputs` round-trip its own explicit template. Today an agent that fills the
`{ concept, content }` envelope returned by `buildInputs({ explicit: true })` gets an
`InputPreparationError` at every file-bearing position, because the walk expects **compact** caller
values. Fix = **Option A, re-wrap on output** (settled decision — see the handoff).

- **Source of truth / full context:** [`wip/prepare-inputs-explicit-envelope.md`](./prepare-inputs-explicit-envelope.md) (archived; decision + runtime evidence + acceptance criteria).
- **File to change:** `src/prepare-inputs.ts` (top-level loop ~line 311; helpers `isFileContent` ~89, `resolveNode` ~189, `resolveFilePosition` ~179).
- **Tests:** `tests/prepare-inputs.test.ts`.
- **Docs:** `docs/input-preparation.md` (§"Signature-driven asset identification" — the "compact inputs" wording is a doc simplification, not a runtime restriction).

---

## Background for a cold start (read this first)

`prepareInputs(client, { files|method_id, pipe_ref?, inputs })`:
1. Resolves the closure → calls `client.buildInputs({ files, format: "json", explicit: true })`.
2. Gets back an **explicit template**: `report.inputs` is `Record<name, { concept, content }>`, where
   `content` is the **compact** canonical content shape (a file input's `content` is `{ url: "…" }`).
3. Walks each caller value against `template[name].content` via `resolveNode`, uploading file-bearing
   positions and rewriting them to `{ url: "pipelex-storage://…" }`.

**The bug (root cause).** The top-level loop walks `entry.content` (compact template) against the raw
caller value:

```ts
// src/prepare-inputs.ts ~line 311
for (const [name, callerValue] of Object.entries(request.inputs)) {
  const entry = template[name];                        // { concept, content: <compact content> }
  if (!isPlainObject(entry) || !("content" in entry)) continue;
  rewritten[name] = await resolveNode(ctx, entry.content, callerValue);  // ← callerValue may be an ENVELOPE
}
```

- When `callerValue` is **compact** (`"https://…"` or `{ url: "…" }`) → works today. ✅
- When `callerValue` is the **explicit envelope** `{ concept, content: { url } }` → `resolveFilePosition`
  sees an object with no top-level `url` key, treats the whole object as a "source", hits
  `doResolveSource` with a non-string/non-bytes value → throws
  `InputPreparationError: Unsupported value at a file input … got object`. ❌

**Why not a one-liner.** Neither template altitude works for both shapes (handoff §"Root cause"):
- Walk `entry.content` against caller → breaks the envelope caller (the bug).
- Walk the whole `entry` against caller → the compact caller `"https://…"` mismatches a plain-object
  template node at `resolveNode` and passes through **unrewritten** (silently wrong — url never becomes `{url}`).

The walk must **detect and normalize the caller's shape**, not pick one template altitude.

**Runtime accepts the envelope (why re-wrap, not strip).** Confirmed against the `pipelex` runtime
(handoff §"✅ RESOLVED"):
- `pipelex/pipelex/core/memory/input_shaper.py` — `_is_explicit(value)` treats a dict whose keys are
  **exactly** `{"concept", "content"}` as a first-class explicit form (D6 arm); `shape()` dispatches to
  `_shape_explicit`. The envelope is a valid run input, **not** compact-only.
- `pipelex/pipelex/pipeline/input_normalizer.py` — file-reference resolution runs over the already-shaped
  `ImageContent`/`DocumentContent` in `WorkingMemory`, so it is envelope-agnostic: a re-wrapped
  `{ concept, content: { url: "pipelex-storage://…" } }` shapes into the same content a compact `{ url }`
  would. → **Preserve the envelope on output**, keeping the concept annotation end-to-end.

---

## The fix (Option A — re-wrap on output)

Replace the body of the top-level loop so an envelope caller value is unwrapped before the walk and
re-wrapped after. Use a **strict** envelope detector matching the runtime's `_is_explicit` (keys are
**exactly** `concept` + `content`, nothing else) — looser `"concept" in … && "content" in …` risks
misclassifying a structured-content input that coincidentally has both fields.

```ts
/** The explicit-template envelope: a plain object whose keys are EXACTLY `concept` + `content`.
 *  Matches the runtime's `_is_explicit` (input_shaper.py) — exact keys, not a superset. */
function isExplicitEnvelope(value: unknown): value is { concept: unknown; content: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && "concept" in value && "content" in value;
}
```

```ts
// in the top-level loop, replacing `rewritten[name] = await resolveNode(ctx, entry.content, callerValue);`
if (isExplicitEnvelope(callerValue)) {
  const walked = await resolveNode(ctx, entry.content, callerValue.content);
  rewritten[name] = { ...callerValue, content: walked };   // re-wrap: keep the concept annotation
} else {
  rewritten[name] = await resolveNode(ctx, entry.content, callerValue);
}
```

**Notes / invariants to preserve:**
- **Copy-on-write** stays intact — `{ ...callerValue, content: walked }` is a fresh object; the caller's
  envelope is never mutated. Keep/add a COW assertion in tests.
- **Text/scalar envelope** (`{ concept: "native.Text", content: "…" }`): unwrap → walk the text template
  against the string → `resolveNode` passes the scalar through unchanged → re-wrap → identical envelope,
  **no upload**. Verify no upload happens.
- **Nested / list under the envelope** is handled for free: after one top-level unwrap, `entry.content`
  (compact template) is walked against the unwrapped `content` by the existing recursive `resolveNode`
  (array + structured-object branches). An envelope whose `content` is a list of file contents, or a
  structured content nesting a file field, resolves exactly as the compact equivalent, then re-wraps.
- **Envelope for an input not in the template** already passes through untouched via the `continue` on
  line ~313 and the `rewritten = { ...request.inputs }` seed — no change needed.
- **Scope:** the envelope is only unwrapped **at the input level** (top of the loop), where the template
  is known to be `{ concept, content: <compact> }`. Do **not** push envelope detection down into
  `resolveNode` — that would re-introduce the false-positive risk against structured-content templates
  and is unnecessary for every acceptance case here.

---

## Implementation checklist

### Phase 1 — Code (`src/prepare-inputs.ts`) ✅ DONE
- [x] Add `isExplicitEnvelope(value)` helper (strict exact-keys check) near `isFileContent`, with the doc comment tying it to the runtime's `_is_explicit`.
- [x] Update the top-level loop to branch on `isExplicitEnvelope(callerValue)`: unwrap `.content`, walk against `entry.content`, re-wrap `{ ...callerValue, content: walked }`.
- [x] Update the module header doc comment to state that callers may submit **either** the compact value **or** the explicit `{ concept, content }` envelope, and that the envelope is preserved on output.

### Phase 2 — Tests (`tests/prepare-inputs.test.ts`) ✅ DONE
New `describe("prepareInputs with the explicit { concept, content } envelope")` block, mirroring the existing style (`makeClient` + `entry` helpers).
- [x] **Envelope file input (bytes)** → `{ concept, content: { url: "pipelex-storage://…" } }`, one upload.
- [x] **Envelope file input (http pass-through)** → re-wrapped, **zero** uploads.
- [x] **Envelope file input (existing `pipelex-storage://`)** → passes through inside the envelope, zero uploads.
- [x] **Envelope file input (data URL)** → decodes + uploads, re-wrapped content.
- [x] **Envelope text input (no upload)** → returned unchanged (still the envelope), zero uploads.
- [x] **Envelope list-of-images** → `content: [{url:…}, {url:…}]`, two uploads.
- [x] **Envelope structured content with nested file field** → only `cover` rewritten, `title` untouched, one upload.
- [x] **Mixed compact + envelope in one `inputs` object** → both handled correctly in a single call.
- [x] **Copy-on-write under the envelope** → caller's envelope and inner `content` not mutated.
- [x] **Equivalence assertion** → envelope call's inner `content` equals the compact call's `photo`; uploads equal.
- [x] All existing compact-shape tests still pass unchanged (268/268 pass).

### Phase 3 — Docs (`docs/input-preparation.md`) ✅ DONE
- [x] Added §"Compact or explicit-envelope inputs" (both shapes accepted, envelope unwrapped/re-wrapped, runtime accepts it — cites `input_shaper.py` `_is_explicit` / `input_normalizer.py`). Updated the `prepareInputs` intro to point to it.
- [x] Reconciled the "compact inputs" phrasing in §"Signature-driven asset identification" (now "the same inputs", with a pointer to the new subsection).

### Phase 4 — Verify ✅ DONE
- [x] `make check` passes (lint + format + typecheck + build + depcruise). **NOTE:** required a dependency refresh — `node_modules/mthds` was stale at `0.21.0`; `package.json` requires `^0.22.0` (the v0.8.0 release that exports `MethodFile`/`parseMethodFiles`). Ran `npm install` → `mthds@0.22.0`. Pre-existing typecheck errors in `client.ts`/`product-models.ts` (unrelated to this change) are resolved by the refresh. `package-lock.json` was updated by the install.
- [x] `make test` passes (268 passed).
- [x] Re-read the handoff's **Acceptance criteria** — all satisfied (see final block below).

### Phase 5 — Release plumbing (deferred to `/release`)
- [~] **CHANGELOG entry — deferred to the `/release` flow, not hand-added.** This repo has no "Unreleased" accumulator; the `/release` skill (Step 6) owns the `## [vX.Y.Z]` heading and drafts the entry from commits interactively (the user picks patch/minor/major). Adding a guessed version heading now would orphan/conflict with that. Ready-to-use draft (drop under the chosen heading at release; **Fixed** — additive, not breaking):

  ```markdown
  ### Fixed

  - **`prepareInputs` now accepts the explicit `{ concept, content }` input envelope, not only compact values.** An agent that fills the explicit template `buildInputs({ explicit: true })` returns — the default template shape the hosted console and MCP hand out — can now hand it straight back to `prepareInputs`. Previously every file-bearing envelope position threw `InputPreparationError: Unsupported value at a file input … got object`, breaking the `buildInputs(explicit) → fill → prepareInputs` round-trip. Per input, the caller may submit either the compact value or the `{ concept, content }` envelope; the envelope's `content` is interpreted identically and preserved on output (the concept annotation rides through — the runtime accepts it via `input_shaper.py`'s `_is_explicit`). Nested/list/structured file positions and mixed compact+envelope inputs are all handled. See [`docs/input-preparation.md`](../docs/input-preparation.md).
  ```
- [ ] Bump version via the `/release` skill when cutting the version the MCP will pin (handoff §"Downstream obligations" #1). Not required to land the code change itself. **A minor bump is the natural fit** (behavior fix, additive surface).

> **Not committed.** Per repo convention, changes are left staged for the user to review; no commit/push was made (not requested). The MCP-side follow-ups (handoff §"Downstream obligations") are tracked in `pipelex-mcp`, not here.

---

## Optional / stretch (do NOT let it block the core fix)

**Reusable file-position helper for the MCP console pass-through** (handoff §"Downstream obligations" #2).
`pipelex-mcp/src/capabilities/prepare.ts` `preparePassThrough` is a hand-kept line-for-line mirror of this
walk and has the **identical** envelope bug. The MCP owner would prefer the SDK expose a small reusable
classifier/normalizer (e.g. export the envelope-unwrap + `resolveNode` seam) so the console can call it
instead of maintaining a parity copy — same "SDK-canonical, swappable-for-native" posture as
`getMethodClosure`.
- [ ] **Decide:** keep the fix `prepareInputs`-internal (simplest, meets all acceptance criteria) **or**
  export a helper for the MCP. Recommendation: land the internal fix first; only extract a helper if the
  API surface is clean (avoid leaking `PrepareContext`/upload internals). If a helper is added, note it in
  the changelog so the MCP can consume it.

---

## Acceptance criteria (from the handoff — final gate) ✅ ALL MET

- [x] `prepareInputs` accepts a filled **explicit** template and a filled **compact** template, producing equivalent prepared inputs. *(equivalence test asserts envelope inner `content` === compact result)*
- [x] File-bearing positions rewrite (upload / pass-through) identically regardless of template shape. *(bytes/http/storage/data-URL cases, both shapes)*
- [x] Text/scalar inputs untouched in both shapes (no accidental upload of an envelope-wrapped string). *(envelope-text test: zero uploads, returned unchanged)*
- [x] Nested / multiplicity (list) file positions work under the envelope. *(list-of-images + nested-structured tests)*
- [x] Output preserves the envelope (`{ concept, content: <rewritten> }`); `docs/input-preparation.md` updated. *(re-wrap in code; new doc subsection)*
- [x] Regression tests cover: compact file input, envelope file input, envelope text input (no upload), envelope list-of-images, mixed compact+envelope, and existing pass-through / data-URL / local-path cases re-run under the envelope shape.

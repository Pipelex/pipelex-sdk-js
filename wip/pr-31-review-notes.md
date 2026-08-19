# PR #31 review triage — deferred items

Triage of the unresolved `chatgpt-codex-connector` and `cubic-dev-ai` review threads on [PR #31](https://github.com/Pipelex/pipelex-sdk-js/pull/31) (the `runCodegenCheck` offline drift check). Three documentation corrections were fixed on the branch, one finding was a false positive, and the two items below are confirmed but deferred. Their PR threads are deliberately left **open**.

Both deferrals turn on the same invariant, so it is worth stating once. `src/codegen-check.ts` is a deliberate mirror of pipelex's `pipelex/codegen/`, and its module header (`src/codegen-check.ts:12-13`) makes that load-bearing: *"A verdict computed here must equal the one `pipelex codegen check` computes over the same bytes — including the drift detail strings, which are kept verbatim so a consumer switching between the CLI and this SDK reads the same report."* Where the SDK already matches the reference, tightening it unilaterally is not a fix — it makes a consumer's CI go red on `@pipelex/sdk` while the CLI calls the same tree current, which is the exact divergence the file already bends over backwards to avoid for CRLF (`src/codegen-check.ts:479-490`).

For the record, the three items that *were* fixed on the branch: "Beside" → "Besides" in `README.md:11`; the overbroad "an incomplete list yields `isCurrent: true`" claim, corrected in both `docs/crate-routes.md:165` and its twin TSDoc bullet on `runCodegenCheck`; and the API sketch's stale `// byte-exact UTF-8 text` comment in `TODOS.md`, aligned with the shipped TSDoc. The false positive was `isWellFormedProjection` — pipelex's `_parse_projection` gates on literally `if len(parts) < 2` and never checks `parts[2]` for emptiness, so the SDK's `parts.length >= 2` mirrors it exactly and the proposed tightening would have been a regression.

## 1. `parseStampFields` ignores uncommented lines inside the stamp block

**Reporters:** `chatgpt-codex-connector` (P1) and `cubic-dev-ai` (P1) — two independent threads on the same finding. **Location:** `src/codegen-check.ts:113-124`.

**The finding, confirmed empirically.** Running the built module against the real vendored fixture with a bare `throw` injected between the markers:

```
// >>> pipelex-codegen-stamp >>>
// crate_fingerprint: e4623057…
// engine_version: 0.46.4
// projection: types / ts-zod
// options: {}
// content_hash: fec606f0…
throw new Error("edited");
// <<< pipelex-codegen-stamp <<<
…body unchanged…
```

yields `isCurrent: true`, `drifts: []`. The trace is exactly as reported: `throw new Error("edited");` contains no `:`, so `separatorIndex === -1` at `src/codegen-check.ts:120` skips the line silently, and `body` is sliced from *below* the end marker so its hash is untouched and still matches both the stamp and the lock.

The field-overwrite variant the reviews raised is **self-defeating rather than an amplifier**. Injecting `content_hash: 0000` does overwrite the field via `fields.set` at `src/codegen-check.ts:123`, but that makes the stamp disagree with the body and the file reports `hand-edited`. A colon-bearing but harmless line (`evil: for (;;) { break evil; }`) merely sets a junk key that nothing reads. So the only invisible variant is the one that changes nothing the hash covers.

**Why it was deferred: the reference does exactly the same thing.** `../pipelex/pipelex/codegen/stamp.py:169-176`:

```python
def _parse_fields(header_region: str, *, comment_prefix: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for raw_line in header_region.splitlines():
        stripped = raw_line[len(comment_prefix) :].strip() if raw_line.startswith(comment_prefix) else raw_line.strip()
        key, separator, value = stripped.partition(":")
        if separator:
            fields[key.strip()] = value.strip()
    return fields
```

That is a line-for-line twin of the TypeScript, including the `else raw_line.strip()` fallback that swallows an uncommented line. The same six mutations run through `parse_stamped` in the pipelex venv give the identical verdict: the injected-`throw` case parses fine, its recomputed body hash matches the stamp, and the reference reports **CURRENT**. Nothing in `check.py` compensates either — `_check_present_artifact` (`../pipelex/pipelex/codegen/check.py:112-124`) consults only `parsed.stamp.content_hash` and `locked_hash`. The SDK is at exact parity, so this is an upstream question, not an SDK one.

**And the stamp is not a security boundary.** The spec (`../docs/specs/pipelex-codegen.md`) scopes the hash deliberately — *"content hash | a hash of the generated **body below the header**, so tampering is detectable"* — and frames the whole chain as drift detection. `stamp.py`'s own docstring says *"a hand edit anywhere **under the stamp** is detectable"*. The header region is out of scope by construction, because the hash is itself a field in that header and cannot cover itself.

More decisively: there is no signature, no MAC, and no secret anywhere in the chain. An adversary who can write into the artifact can also recompute `content_hash` — this repo's own test helper `regenerate()` (`tests/helpers/codegen-stamp.ts:49-52`) does it in three lines — and edit the plaintext `codegen.lock` sitting beside it, yielding `isCurrent: true` over arbitrary content. Every variant, this one included, leaves an obvious git diff. The defence against malicious insertion is diff review, not the stamp. The realistic threat the check exists for is accidental edits and stale artifacts, and an accidental edit does not land inside a five-line `// key: value` block under a `DO NOT EDIT` banner.

**Blast radius if it is ever fixed.** Only two implementations exist: `pipelex` and this SDK. `pipelex-sdk-python` has no mirror of this check.

**Ready-to-apply change — both repos, one lockstep move.** Upstream goes first; the SDK follows once it lands.

In `src/codegen-check.ts`, immediately after `headerRegion` is computed:

```ts
if (!headerRegion.split("\n").every((line) => line.startsWith(commentPrefix))) {
  return null;
}
```

and the mirror in `parse_stamped` (`../pipelex/pipelex/codegen/stamp.py`, after the `header_region` slice):

```python
if any(not line.startswith(comment_prefix) for line in header_region.splitlines()):
    return None
```

**Verified safe on shape.** `apply_stamp` (`../pipelex/pipelex/codegen/stamp.py:117-120`) emits `[begin] + [f"{prefix} {key}: {value}" …] + [end]` — every header line carries the prefix and no blank lines are emitted. Both vendored fixtures (`tests/fixtures/codegen/ts-zod/types.ts.txt`, `tests/fixtures/codegen/python-pydantic/models.py.txt`) confirm it. So the tightening breaks no real stamp; it is unsafe only on *parity*, which is why it must move in both repos together.

**Test to add on the SDK side**, in the existing `describe("runCodegenCheck — drift categories")` block of `tests/codegen-check.test.ts`, in that suite's established style (`STAMP_END` is already imported there):

```ts
it("reports an uncommented line inside the stamp header as `hand-edited`", async () => {
  const input = withEdit(tsFixture(), "types.ts", (content) =>
    content.replace(`// ${STAMP_END}`, `throw new Error("edited");\n// ${STAMP_END}`),
  );
  const report = await runCodegenCheck(input);
  expect(report.drifts[0]?.category).toBe("hand-edited");
});
```

**Next action: file the follow-up on `pipelex`, which owns the reference.** Both PR threads stay open until it lands.

## 2. Drift ordering diverges from the reference CLI

**Reporter:** `cubic-dev-ai` (P2). **Location:** `src/codegen-check.ts:501` (`sortedEntries`), used at both `:288` and `:299`.

There are **two** ordering divergences here. The review found the one that is essentially unreachable; verification turned up a second that is reachable with plain ASCII. Neither can change a verdict — but if this is ever picked up, both must move together, because fixing only the reported one would leave the more likely failure in place while looking addressed.

### 2a. The reported divergence: UTF-16 code units vs Unicode code points

JavaScript's `<` and `>` on strings compare UTF-16 code units; Python's compare code points. The window where they disagree is a supplementary character (U+10000–U+10FFFF, stored as a surrogate pair) against a BMP character in U+F900–U+FFEF. Confirmed pairs:

| paths | JS (code units) | Python (code points) |
| --- | --- | --- |
| `😀.py` (U+1F600) vs `ﬀ.py` (U+FB00) | `😀.py` first | `ﬀ.py` first |
| `𐀀.py` (U+10000) vs `豈.py` (U+F900) | `𐀀.py` first | `豈.py` first |

The existing path validation does **not** close this. `CONTROL_CHARACTER = /\p{C}/u` (`src/codegen-check.ts:436`) mirrors `../pipelex/pipelex/codegen/lock.py:73` exactly, and both engines agree on which categories it rejects: `Cc`, `Cf`, `Cs` (lone surrogate), `Co` (private use, U+E000–U+F8FF) and `Cn` (unassigned). A *paired* surrogate — a genuine astral character — is `Lo`/`So`, not `C`, and passes both sides. That is what narrows the window to U+F900–U+FFEF rather than all of U+E000–U+FFFF.

**Why it is unreachable in practice.** Codegen filenames are hardcoded constants, not derived from user text: `../pipelex/pipelex/codegen/emitters/python_pydantic.py:26` → `"models.py"`, `python_structures.py:34` → `"structures.py"`, `ts_zod.py:31-32` → `"types.ts"` and `"binder.ts"`. That is the entire universe of artifact paths — four flat ASCII names. Locked paths come from `build_lock` over those filenames (`emission.py:83`), and orphan paths must carry a codegen stamp, so they originate there too. Reaching the divergence needs a hand-edited `codegen.lock` — whose own header says *do not edit by hand* — carrying two exotically named entries in complementary Unicode ranges.

### 2b. The unreported divergence: full-string vs path-component ordering

This one needs no Unicode at all. The reference is internally inconsistent between its two loops:

- **Locked-artifact loop** — `../pipelex/pipelex/codegen/check.py:101`: `for path, locked_hash in sorted(lock.hash_by_path().items()):`, a plain `str` sort, i.e. code-point order over the whole path. `src/codegen-check.ts:288` mirrors this correctly apart from 2a.
- **Orphan loop** — `check.py:130` iterates `_iter_stampable_files`, a pre-order DFS doing `sorted(directory.iterdir())` at each level (`check.py:148`). That is a path-*component* sort, not a full-string sort:

```
sorted([PurePosixPath("models.py"), PurePosixPath("models/foo.py")])
  -> [PurePosixPath('models/foo.py'), PurePosixPath('models.py')]
sorted(["models.py", "models/foo.py"])            # plain str
  -> ['models.py', 'models/foo.py']
```

`src/codegen-check.ts:299` sorts orphans by raw string, so for a tree holding a `models/` directory beside a `models.py`, the CLI reports `models/foo.py` first and the SDK reports the reverse. Nested stampable files are explicitly in scope — the `runCodegenCheck` TSDoc obliges the caller to "walk the whole tree, recursively", and `tests/codegen-check.test.ts:340` already exercises a nested file. One comparator cannot mirror both loops.

**Why both were deferred.** Only the **order** of the `drifts[]` array changes. `isCurrent`, every `category`, and every `detail` string are untouched, so the verdict and the reported text stay identical across implementations. `../docs/specs/pipelex-codegen.md:94-104` pins the algorithm but says nothing about ordering, so the promise being bent is an SDK-local doc line (`docs/crate-routes.md:139`, "each sorted by path — so a consumer can print it, snapshot it, or diff two runs"), not a spec contract. Roughly twenty lines of comparator plus tests, to fix an ordering difference that cannot redden anyone's CI, is the "guard impossible cases" churn the no-overengineering rule exists to prevent.

**Ready-to-apply change, if it is ever picked up.** Do it once and completely — both comparators, or neither. There is no readable one-liner: `localeCompare` is locale-dependent, and spread or `Array.from` still compares single-character *strings* by code unit unless you call `.codePointAt(0)`.

```ts
/** Compare by Unicode code point — Python's `str` order, not JS's UTF-16 code-unit order. */
function compareCodePoints(left: string, right: string): number {
  const leftChars = [...left];
  const rightChars = [...right];
  const shared = Math.min(leftChars.length, rightChars.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftChars[index]!.codePointAt(0)! - rightChars[index]!.codePointAt(0)!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftChars.length - rightChars.length;
}
```

verified to reproduce Python's `sorted()` exactly on the mixed corpus `["😀.py", "ﬀ.py", "豈.py", "𐀀.py", "a.py", "models.py", "models/foo.py"]`. The orphan loop additionally needs a component-wise wrapper — `left.split("/")` against `right.split("/")`, compared element-wise with `compareCodePoints` — to mirror the DFS. That means `sortedEntries` splits into two call sites rather than staying one shared helper.

**Testing.** Both cases belong in the existing `describe("runCodegenCheck — drift ordering")` block at `tests/codegen-check.test.ts:290`, whose style is `expect(report.drifts.map((drift) => [drift.path, drift.category])).toEqual([...])`. The nested-orphan case is the one worth pinning first: `plus(tsFixture(), { path: "models/foo.ts", … }, { path: "models.ts", … })` with both stamped.

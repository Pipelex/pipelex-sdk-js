# PR #31 review triage — deferred items

Triage of the unresolved `chatgpt-codex-connector` and `cubic-dev-ai` review threads on [PR #31](https://github.com/Pipelex/pipelex-sdk-js/pull/31) (the `runCodegenCheck` offline drift check). Three documentation corrections were fixed on the branch, one finding was a false positive, and items 1 and 2 are confirmed but deferred — their PR threads are deliberately left **open**. Items 3 onward were added later, by a full `/review` pass over the same branch; they have no PR thread and are introduced by their own heading below. A final section collects the follow-ups that belong to **`pipelex`** rather than to this SDK. **Status as of 2026-08-19: all five have landed upstream** on `pipelex`'s `feature/Codegen-followups`, committed but unpushed and unreleased — see [`upstream-codegen-followups-mirror.md`](upstream-codegen-followups-mirror.md) for what each one now requires of this repo, and in which direction it travels.

Both deferrals turn on the same invariant, so it is worth stating once. `src/codegen-check.ts` is a deliberate mirror of pipelex's `pipelex/codegen/`, and its module header (`src/codegen-check.ts:12-13`) makes that load-bearing: *"A verdict computed here must equal the one `pipelex codegen check` computes over the same bytes — including the drift detail strings, which are kept verbatim so a consumer switching between the CLI and this SDK reads the same report."* Where the SDK already matches the reference, tightening it unilaterally is not a fix — it makes a consumer's CI go red on `@pipelex/sdk` while the CLI calls the same tree current, which is the exact divergence the file already bends over backwards to avoid for CRLF (`src/codegen-check.ts:479-490`).

For the record, the three items that *were* fixed on the branch: "Beside" → "Besides" in `README.md:11`; the overbroad "an incomplete list yields `isCurrent: true`" claim, corrected in both `docs/crate-routes.md:165` and its twin TSDoc bullet on `runCodegenCheck`; and the API sketch's stale `// byte-exact UTF-8 text` comment in `TODOS.md`, aligned with the shipped TSDoc. The false positive was `isWellFormedProjection` — pipelex's `_parse_projection` never checks `parts[2]` for emptiness, so the SDK's handling of the *reviewed* sub-question mirrors it and the proposed tightening would have been a regression. **Correction (2026-08-19):** the sentence that followed here originally read "mirrors it exactly", which overstated it. `_parse_projection` gates on two conditions, not one — `if len(parts) < 2` **and** `if kind is None or target is None`, resolving both axes against `CodegenKind`/`CodegenTarget`. The SDK omits the second gate, so `projection: BOGUS / NONSENSE` verifies here and is `hand-edited` upstream. That omission is deliberate and is now pinned in both directions by tests and named in `docs/crate-routes.md` under "Where it knowingly differs from the CLI" — but it is a real divergence, not a non-difference, and the reply on the cubic thread should not be read as covering it.

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

**Update (2026-08-19): it has landed upstream** — `parse_stamped` now rejects any header line without the comment prefix, and the `else raw_line.strip()` fallback is gone. The threads stay open one more beat, because the tightening must *ship* before this module mirrors it: a released SDK stricter than the released CLI reddens a consumer's CI on a tree `pipelex codegen check` still calls current.

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

---

# Second review round (2026-08-19) — items 3 onward

Items 1 and 2 above came from the `chatgpt-codex-connector` and `cubic-dev-ai` threads on PR #31 and still have open threads. Everything from here down came from a later full `/review` pass over the same branch, has **no** PR thread, and was reproduced against the built `dist/` before being written down.

That pass did not only defer. It **fixed** four verdict-flipping parity divergences outright — the stamp-header line-boundary set, the strip set, the Windows drive-prefix rule, and the strict-decode obligation in the docs — plus the `sideEffects` declaration, a `.gitignore` gap that left a live `PIPELEX_API_KEY` one `git add -A` from publication, and six inaccurate documentation claims. See the changelog's `Fixed` entry and `docs/crate-routes.md` → "Where it knowingly differs from the CLI". What follows is what it found and deliberately did **not** fix.

The ordering below is by consumer impact, not by discovery order.

## 3. Public-entry robustness

### 3a. A Windows tree walk cannot call the check at all

`validateCanonicalPath` rejects any path containing a backslash (`src/codegen-check.ts:501`), and `indexTreeFiles` (`src/codegen-check.ts:391`) applies it to **caller-supplied tree paths**, not only to lock paths. Reproduced: a tree file whose path uses a backslash separator throws `CodegenLockError`.

`path.relative()` returns backslash-separated paths on win32, so the obvious implementation of the `readTree(...)` placeholder in the documented CI recipe (`docs/crate-routes.md`) hard-fails on Windows CI. The inconsistency is worth stating plainly: the module goes to real trouble to normalize newlines *specifically so a Windows checkout does not produce a wrong verdict*, then rejects Windows path separators outright. The reference never validates walked paths at all — `_find_orphans` derives them from the filesystem via `.as_posix()` (`../pipelex/pipelex/codegen/check.py`), so this strictness is SDK-only and has no parity justification.

It fails loudly rather than silently, which is why it is not ranked above the security items — but a consumer who wraps the call in a `try`/`catch` that warns-and-continues has converted it into an ungated CI.

**Fix when taken:** normalize the backslash separator to `/` on **tree** paths only, leaving `validateArtifactPath` strict for lock paths (where a backslash really is malformed, since the emitter writes POSIX). At minimum, spell the `.split(sep).join("/")` conversion in the documented example.

### 3b. Plain-JS misuse raises `TypeError`, not the documented `CodegenLockError`

`docs/crate-routes.md` → "What the check throws" names `CodegenLockError` as the one thing the check throws. The package is published to npm and TypeScript types do not survive into a JS consumer. Reproduced against `dist/`:

| input | result |
| --- | --- |
| a tree file with `path` but no `content` | `TypeError` — `normalizeNewlines` on `undefined` |
| a tree file whose `path` is `null` | `TypeError` — `path.includes` on `null` |
| `files` omitted entirely | `TypeError` — not iterable |

**Fix when taken:** `typeof` guards in `indexTreeFiles` raising `CodegenLockError`, so the documented contract holds for JS callers too.

### 3c. A header-only lock reports `isCurrent: true`

Reproduced: a lock carrying only `crate_fingerprint` and `engine_version`, against an empty tree, returns `isCurrent: true, drifts: []` — and so does an explicit `artifacts = []`.

The reference carries `lock_found` and defines its verdict as `lock_found and not drifts`; the port drops the field deliberately ("a missing lock is the caller's own concern"), which is right for a *missing* lock but leaves a *truncated* one with no opinion. Paired with a walk that returned nothing, a half-written lock is silently green. Reachability is low — a real `codegen()` lock always carries artifacts, and a non-empty tree against an empty lock produces orphans, which the no-verdict suite now pins — so this is recorded rather than fixed.

## 4. Error-message hygiene

All three reproduced against `dist/`. None affects a verdict; all three concern what a CI log receives from a repo-local file, which a malicious PR to an open-source consumer controls.

- **4a. Raw control characters are echoed into messages.** `raisePathError` (`src/codegen-check.ts:524`) interpolates the path verbatim — including on the branch that just rejected it *for containing control characters*. `describeError` (`src/codegen-check.ts:429`) additionally embeds smol-toml's `TomlError.message`, which by construction contains a three-line codeblock of the raw lock source. A lock carrying an ANSI escape produces a message that still contains it, so terminal output can be rewritten or hidden.
- **4b. Message length is unbounded in the input's line length.** A lock with one 200k-character line produced a roughly 400 KB `CodegenLockError` message (measured).
- **4c. The two header strings are surfaced unvalidated.** `crate_fingerprint` and `engine_version` are type-checked only (`src/codegen-check.ts:436`) and flow straight into the public report, which the docs tell callers to print. Reproduced: a lock whose `crate_fingerprint` is a TOML basic string carrying an escaped ANSI colour sequence returns that value intact, with `isCurrent: true`. Note the asymmetry — artifact *paths* from the same lock are control-character-validated, these are not.

**Fix when taken:** escape non-printables and truncate before interpolating, and apply the existing `CONTROL_CHARACTER` rejection (or a shape check, since both values are machine-emitted) to the two header strings.

## 5. Packaging

- **5a. The compiled hook tree ships and is unreachable.** `npm pack --dry-run` lists nine `dist/hooks/*` entries (~43 kB). The `exports` map publishes only `"."`, and the hook is consumed as the separately-bundled `dist-hooks/check.mjs`, which is not in `files` at all. Giving the hook its own tsconfig `outDir` would shrink the tarball and make a blanket `sideEffects: false` true again — the array form landed this round is the smaller, safer half of that fix.
- **5b. `smol-toml` loads for every consumer.** `src/index.ts` statically re-exports `runCodegenCheck`, so Node's ESM loader evaluates the TOML parser even for a consumer that only ever calls `execute()`. Measured with a loader hook: a client-only import of `PipelexApiClient` loads all nine smol-toml modules, `stringify.js` included, which this SDK never calls. Bundlers tree-shake it (measured: 0 bytes retained), Node does not. The dependency audits clean, so this is blast radius, not a live risk. **Note before acting:** the settled decision in `TODOS.md` is one barrel, no subpath export — so the option that does not reopen it is a dynamic `await import("smol-toml")` inside `parseLock`, which `runCodegenCheck` being async already permits.

## 6. Our own CI cannot see upstream grammar drift

`.github/workflows/quality-checks.yml` runs `make all`, which is `clean check test` (`Makefile:128`). `make test-e2e` is in no workflow and there is no scheduled job — confirmed. Meanwhile the vendored fixtures pin `engine_version = "0.46.4"` and `.gitattributes` deliberately freezes their bytes.

So the unit suite is green forever by construction. If pipelex changes the stamp grammar, the `kind` / `target` vocabulary, or the lock shape, nothing here goes red — and the lock case is the sharp one, because `rejectUnknownKeys` turns **any** newly added lock key into a hard `CodegenLockError`, i.e. a no-verdict for every consumer, which our CI would never see coming. `docs/architecture.md` says the e2e "pins the port against the stamp and lock bytes the server writes today"; that is true only when a human runs it with a live server and a key.

**Fix when taken:** a scheduled job running `make test-e2e` against a known runner, or an explicit note in `docs/architecture.md` that the parity guarantee is human-gated.

## 7. Accepted parity differences

Recorded so they are not rediscovered as bugs. Both are now named in `docs/crate-routes.md` → "Where it knowingly differs from the CLI".

- **The projection line is shape-checked, not vocabulary-checked.** A stamp whose projection names an unknown kind or target verifies here and is `hand-edited` upstream. Deliberate: an SDK copy can lag the emitter, and tightening it would report every artifact of a newer-engine tree as a hand edit. Now pinned in **both** directions by tests, so the decision cannot be silently reversed. See the correction at the top of item 1 — the original triage note read this as a non-difference, which it is not.
- **`JSON.parse` versus `json.loads` on `NaN` and `Infinity`.** Python accepts them in the stamp's `options` value and JavaScript does not, so a stamp carrying a bare `NaN` there is current upstream and `hand-edited` here. This is the one differential where the SDK is the **stricter** side, and it is unreachable with today's emitter, whose `options` is a `dict[str, str]`.

## 8. Tidy-ups

Low value individually; grouped so a future pass can sweep them together.

- `sha256` is exported from `tests/helpers/codegen-stamp.ts:25` but used only inside that module.
- `tests/e2e/crate.e2e.ts` re-implements the unit suite's `withEdit` / `without` / `contentOf` tree mutators inline. The helper module was created precisely to stop the two suites keeping private copies of shared machinery; the stamp half moved and the tree half did not.
- "The caller's obligations" exists twice in near-verbatim long-form prose — the `runCodegenCheck` TSDoc and `docs/crate-routes.md`. That duplication has already cost a double edit once (the `isCurrent: true` correction recorded at the top of this file), and it cost a second one this round.
- `checkPresentArtifact` (`src/codegen-check.ts:374`) comments that a branch is unreachable, then folds it into a `hand-edited` drift rather than failing loudly. If the invariant ever breaks, every artifact of that type is silently reported hand-edited instead of surfacing the wiring bug. The reference's `comment_prefix_for` raises instead.
- The repo `CLAUDE.md` "Structure" block lists five of eleven `src/` modules. Pre-existing and not caused by this branch, but `docs/architecture.md` is now the only accurate module map.

---

# Upstream follow-ups — `pipelex` (Python), and one for `docs/specs/`

Everything above is SDK-side. These are the items this branch's work surfaced that **`pipelex` owns**, collected here because that is where the analysis is — the same convention item 1 already follows by carrying a ready-to-apply `stamp.py` patch. **Status (2026-08-19): all five have landed upstream**, on `pipelex`'s `feature/Codegen-followups` — committed, unpushed, unreleased. The analysis below is kept as written, because it is the record of *why* each was filed; the per-item status lines say what changed. What this repo must now do, and the release ordering that governs it, is in [`upstream-codegen-followups-mirror.md`](upstream-codegen-followups-mirror.md). Originally verified against `pipelex 0.46.4` (`dev` at `d28e703e3`), the same version the vendored fixtures came from.

U3 is the one with real blast radius; the rest are correctness tidiness.

## U1. `_parse_fields` accepts uncommented lines inside the stamp header

Already written up as item 1 above, including the reproduction, the reasoning for why the SDK must **not** fix it unilaterally, and the two-line patch for both repos. Restated here only so the upstream list is complete.

**Landed upstream.** The gate is in, the dead fallback is gone, and the reproduction is a test at both the parser and check levels. The SDK follows *after* a pipelex release, never before. One second-order effect came with it: upstream's regenerator uses the same parse to decide whether it owns a destination, so a file with an injected header line is now unowned — the check calls it an orphan advising *remove or regenerate* while regeneration refuses to overwrite it. The refusal was kept deliberately and pinned by a test.

## U2. `run_codegen_check`'s two loops sort by different rules

Written up as item 2b above. `_check_locked_artifacts` iterates `sorted(lock.hash_by_path().items())`, a plain `str` sort over the whole path; `_find_orphans` iterates `_iter_stampable_files`, a pre-order DFS doing `sorted(directory.iterdir())` at each level, which is a path-*component* sort. For a tree holding a `models/` directory beside a `models.py`, the two halves of one report are ordered by different rules. That is an inconsistency in the reference itself, not an SDK divergence, so upstream owns whether to unify it — and which way.

**Resolved upstream, in this module's favour.** Both loops now use the plain full-string sort — `_find_orphans` sorts its result instead of returning walk order — and the ordering is written down as a contract: every locked-artifact drift first, then every orphan, each group by path. **Nothing to do here**, and item 2b above is closed: `models/foo.py` vs `models.py` now agrees between the two implementations with no change to this module. Only 2a (UTF-16 code units vs code points) survives, on the same deferral grounds as before.

## U3. Adding any key to `codegen.lock` is a hard break for every pinned client

**This is the one worth acting on.** `CodegenLock` and `CodegenLockEntry` both carry `model_config = ConfigDict(frozen=True, extra="forbid")` (`pipelex/codegen/lock.py:41,50`). The SDK mirrors that deliberately (`rejectUnknownKeys`), for a good reason recorded in `TODOS.md`: the lock is Pipelex-owned and written by a versioned engine, so an unrecognized shape means the two sides disagree about what the hashes cover, and a loud no-verdict beats a confident wrong one.

The consequence is the part nobody has decided. Because an unknown key is a **no-verdict** (`CodegenLockError`) rather than a drift, the day `pipelex` adds any field to the lock — a format version, a target list, a timestamp — every consumer pinned to a `@pipelex/sdk` released before it gets a hard throw in CI, not a warning and not a drift report. An older `pipelex` reading a newer lock breaks the same way. The lock format currently has no version field and no stated evolution policy, so there is nothing today that makes an additive change safe.

Upstream owns the format, so upstream owns the choice. Roughly: add a `lock_version` (or `format`) field now, while the only two readers are ours and the cost is zero; or write down that the lock is closed and additions are breaking, so a change to it is understood to require a coordinated release across `pipelex`, `@pipelex/sdk`, and any future `pipelex-sdk-python` mirror. Either is fine. Silently discovering it during a release is not.

**Landed upstream, and it inverts the usual direction — this is the blocker.** Every lock now opens with `lock_version = 1`, and the reader refuses a version it does not know, reading the version *before* the key set so a future lock is diagnosed by its version rather than by whichever new key it carries first. Because this module rejects unknown lock keys, **an `@pipelex/sdk` that tolerates the key must be published before the pipelex release that writes it** — otherwise the very release that fixes U3 causes the failure U3 describes. The four rules to mirror are in [`upstream-codegen-followups-mirror.md`](upstream-codegen-followups-mirror.md).

## U4. On Windows, artifacts are written CRLF while their recorded hashes are over LF

`save_text_to_path` is `path.write_text(text, encoding="utf-8")` (`pipelex/tools/misc/file_utils.py:80`). With the default `newline=None`, `write_text` translates every `\n` to `os.linesep`, so on Windows the emitted artifact is CRLF on disk — while `compute_content_hash` hashed the in-memory string, which is LF. The verdict still comes out right, because `load_text_from_path` reads back through universal-newline translation; that asymmetry is exactly what this branch discovered and why `runCodegenCheck` normalizes newlines rather than hashing raw bytes.

What it does break is a claim `apply_stamp`'s own docstring makes: *"a producer that regenerates the same body against the same crate and engine writes byte-identical output (the enabler for write-if-changed)."* That holds per-platform, not across platforms — the same method regenerated on Windows and on Linux produces different bytes, so a repo whose contributors are on both platforms will see the generated tree churn in git even when nothing changed. Note this is reasoned from the code path and Python's documented `write_text` behaviour, **not** reproduced on a Windows host; the macOS `os.linesep` is `\n`, so the effect is invisible here.

Cheap fix if taken: pass `newline="\n"` at the write site so emitted artifacts are LF on every platform and the bytes match the hash that was recorded for them. Consumers already recommend a `.gitattributes` entry for the same tree, so this mostly removes a surprise rather than changing a contract.

**Landed upstream**, and fixed globally in `save_text_to_path` rather than only at the codegen write site, so every product text artifact is LF on every platform. **Invisible to this module**, which already normalizes newlines before hashing.

## U5. `json.loads` accepts `NaN` and `Infinity` in the stamp's `options`

`_parse_options` uses a bare `json.loads`, which accepts the non-standard `NaN`, `Infinity` and `-Infinity` literals. No conformant JSON parser does, JavaScript's included — so a stamp carrying one is current to `pipelex codegen check` and `hand-edited` to `runCodegenCheck`. This is the one differential where the SDK is the stricter side, and it is unreachable today because `options` is typed `dict[str, str]` and `json.dumps` will never emit those literals for string values.

Worth closing anyway, since it costs one argument: `json.loads(options_raw, parse_constant=_reject)`. The stamp header is a cross-language interchange format, and it should not be able to contain something only Python can read.

**Landed upstream** via `parse_constant`. **Nothing to do here** — `JSON.parse` already refuses these literals, which is what made this the one differential where the SDK was the stricter side; that gap is now closed from the other end.

## S1. The spec does not pin what a second implementation actually needs

Not a `pipelex` item — this one belongs to the workspace `docs/specs/` + `conformance/` pair.

`docs/specs/pipelex-codegen.md` → "Offline check algorithm" says the check "is pure hashing, so any client (the CLI, an SDK, a short CI script) implements it identically", and the section is still marked `unverified`. This branch built that second client, and three properties turned out to be load-bearing that the three-step prose does not state:

- **At most one drift per locked path, with `hand-edited` outranking `modified`.** The prose reads as two independent passes; an implementation written from it emits two drifts for a hand edit and diverges.
- **The orphan predicate is `has_stamp`, not the full parse.** Using the stronger check silently ignores exactly the stale file the lock exists to catch.
- **Drift ordering is deterministic** — locked drifts first, then orphans. Consumers print and snapshot this.

All three had to be derived by reading `check.py`. That is the gap a spec exists to close, and it is now demonstrated rather than hypothetical: the spec claims identical implementability, and identical implementability did not hold from the spec alone. Worth folding into the section when it de-skeletons in conformance, along with a note that the stamp-header *text* rules (line boundaries, the strip set) are part of the hashed contract too — this branch fixed four verdict-flipping divergences that all came from reimplementing Python string semantics in another language.

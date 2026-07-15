# PR #13 review follow-ups (deferred)

Confirmed-but-deferred items from the SWE-agent review of https://github.com/Pipelex/pipelex-sdk-js/pull/13. Each was verified against the code; they are deferred because they need a design decision or more context than a PR-review pass should unilaterally resolve — not because they are wrong.

## 1. `files` XOR `method_ref` is not enforced client-side

- **Reporter:** cubic-dev-ai — [thread](https://github.com/Pipelex/pipelex-sdk-js/pull/13) on `src/models.ts` (`BuildRequestBase`).
- **Issue:** The wire contract requires exactly one of `files[]` / `method_ref` (`../docs/specs/pipelex-codegen.md` — neither or both ⇒ 422), but `BuildRequestBase` models them as two independent optionals, so a request with neither (or both) type-checks and only fails after the network call.
- **Why deferred (needs-judgment):** `method_ref` is reserved — the server answers 501 for it today — so the "both" arm is academic, and the TS XOR-union pattern (`{files; method_ref?: never} | {files?: never; method_ref}`) would force `BuildRequestBase` from an interface into a union and the three route request types from `extends` into intersections. Disproportionate ceremony for a field nobody can use yet.
- **Recommendation:** if/when this gap is closed (e.g. when `method_ref` becomes real), prefer a small runtime fail-fast guard shared by the three build methods — throw `PipelineRequestError` before the network call, matching the `execute`/`start`/`validateFiles` idiom — over the type-level union.

## 2. Hidden `.mthds` files are excluded from the hook's validation bundle

- **Reporter:** cubic-dev-ai — thread on `src/hooks/bundle-gather.ts` (~line 50).
- **Issue:** The dot-prefix skip in `walkMthdsFiles` runs for every directory entry, files included, so a `.hidden.mthds` file is silently dropped from the bundle. This contradicts the code's own comment ("dot-dirs are skipped wholesale") and could in principle produce an undetected under-supplied bundle → a false block on valid code.
- **Why deferred (needs-judgment):** correctness depends on what the pipelex runtime's own bundle scan (`library_utils.py`) does with hidden files — the bundle gather is documented as a mirror of that scan. If the runtime skips hidden files, the current behavior is *correct* and only the comment is misleading; if the runtime loads them, the skip should be gated on `entry.isDirectory()`. Unverifiable from this repo.
- **Open question:** check `pipelex`'s library scan semantics for dot-prefixed files, then either gate the skip on directory entries (and add a test that a `.hidden.mthds` sibling is included) or fix the line-17 comment to say hidden *entries* are skipped.

## 3. Bundle-gather caps are applied after the full tree walk

- **Reporter:** cubic-dev-ai — thread on `src/hooks/bundle-gather.ts` (~line 77).
- **Issue:** `walkMthdsFiles` collects every `.mthds` path before the file/byte caps are checked, so a pathological tree is walked in full before the hook reports `overflow`.
- **Why deferred (secondary):** the walk accumulates path strings only (memory is O(file count), not bytes), the usual big directories (`node_modules`, dot-dirs, venvs, `results`) are pruned, the scan root is the edited file's parent directory rather than a repo root, and the byte cap requires statting the files anyway. Bounding the count mid-walk would need restructuring the throw-vs-overflow signaling for a theoretical case.
- **Recommendation:** leave as-is unless real-world evidence of slow per-edit scans shows up; then short-circuit the file-count cap inside the walk with a distinct overflow signal (not the `unreadable` throw path).

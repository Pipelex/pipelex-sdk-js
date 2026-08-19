---
delivered_from: workspace `wip/inbox/2026-08-19-pipelex-sdk-js-codegen-lock-version.md`
delivered_on: 2026-08-19
upstream_state: `pipelex` `dev` — PR #1127 (U1–U5) and PR #1128 (the line-boundary pin) are **merged and unreleased**
mirrored_on: 2026-08-19
---

# Mirroring the upstream codegen follow-ups

`pipelex` has landed all five upstream items this PR's review surfaced (U1–U5 in [`pr-31-review-notes.md`](pr-31-review-notes.md)), merged to `dev` and unreleased. This is what that meant for `src/codegen-check.ts`, and — the part that mattered most — **which direction each one travels in**, because they do not all travel the same way.

**Status: the mirroring is done.** The two items that needed code here — U3's `lock_version` reader and U1's comment-prefix gate — are both on this branch, with the version gate ordered ahead of key-set validation and the gate splitting on the wide line-boundary set. What remains is a *release*, not a change; see "What is still open" at the end.

The invariant that governs everything below is the module's own: a verdict computed here must equal the one `pipelex codegen check` computes over the same bytes. That is why the SDK must never be *stricter* than the CLI, and equally why it must not be *less tolerant* of a format the CLI has started writing.

| Upstream item | What landed there | What this repo does | Direction |
|---|---|---|---|
| U1 — uncommented lines inside the stamp header | header lines must all carry the comment prefix; the `else raw_line.strip()` fallback is gone | **ported** — the gate is in `parseStamped`, the tolerant ternary is gone | would have been **after** a pipelex release; rides along instead, since no released SDK is stricter than the released CLI |
| U5 — `NaN` / `Infinity` in the stamp's `options` | `json.loads` now refuses the non-standard JSON constants | nothing — `JSON.parse` already refuses them; this closed a gap where the SDK was the stricter side | already aligned |
| U2 — drift ordering | both loops unified on the plain full-string sort; `_find_orphans` now sorts its result | **nothing** — upstream converged toward the comparator this module already used | resolved upstream |
| U4 — CRLF artifacts on Windows | `save_text_to_path` writes `newline="\n"` everywhere | nothing — this module already normalizes newlines before hashing | invisible here |
| U3 — the lock format has no version | every lock now opens with `lock_version = 1` | **ported** — the reader knows the key; publishing it is what is left | **before** a pipelex release |

## U3 is the one that inverts — and it turned out not to be a blocker

`src/codegen-check.ts` rejects unknown lock keys, deliberately, mirroring pydantic's `extra="forbid"`. So a reader that has not learned the key gets a hard `CodegenLockError` no-verdict in CI the moment a pipelex release starts writing it — not a drift, not a warning. That is precisely the failure U3 was filed to eliminate.

**The urgency is lower than the handoff assumed, and worth stating precisely, because pipelex is holding a release on it.** `runCodegenCheck` has never been published: it sits under `## [Unreleased]` in `CHANGELOG.md`, and `npm install @pipelex/sdk@0.12.0` ships no `dist/codegen-check.js` at all (verified against the tarball). So **no published `@pipelex/sdk` reads `codegen.lock` in any version**, and a pipelex release today would break no SDK consumer, because none can run the check.

What that changes: the constraint is not "SDK first or CI goes red", it is the simpler **"the first `@pipelex/sdk` release containing `runCodegenCheck` must already read `lock_version`"** — which is now true on this branch. The two releases are therefore independent and can ship in either order. The ordering only becomes load-bearing once an SDK carrying the check is in the wild.

### The four rules to mirror

1. **A lock with no `lock_version` key is version 1 by definition.** Nothing on disk needs migrating; every lock written before the field existed is already conformant. Keep at least one vendored fixture without the key to pin this.
2. **A reader refuses any version it does not know, and says which side to upgrade.** A version *greater* than the one it reads means "written by a newer Pipelex codegen — upgrade". Anything else (`0`, negative, non-integer, boolean) is malformed, not a future version. Upstream had to exclude booleans explicitly, because Python's `bool` is an `int` subclass and `True == 1`; whatever the JS equivalent hazard is, cover it.
3. **The version is read *before* the key set is validated.** This is the load-bearing ordering and the easiest thing to get wrong. Otherwise `rejectUnknownKeys` fires on a key a future writer was entitled to add and reports an opaque shape complaint instead of naming the version — the unactionable no-verdict U3 exists to remove. Upstream pins this with `test_a_newer_lock_version_is_refused_even_when_it_carries_unknown_keys`, and mutation-testing it (moving the gate back after validation) turns it red. Port that test.
4. **Strictness *within* a known version stays.** `extra="forbid"` is unchanged upstream; `rejectUnknownKeys` should be too.

Keep the message wording aligned with the CLI's, so a user who hits this in either toolchain reads the same sentence.

**How the four landed here**, since two of them needed a judgment the rules could not make in advance:

- Rule 1 holds without a new fixture: both vendored locks are real output from a pipelex that predates the key, so the existing pristine-tree suite already *is* the legacy-lock pin. They were deliberately left unedited — hand-adding `lock_version = 1` would make them no longer real generator output, which is the one property the fixture README says they exist to have.
- Rule 2's boolean hazard does not exist in JavaScript: `typeof true === "number"` is false, so a TOML boolean is excluded by the same check that requires an integer. The JS hazard is a different one, and it is *not* fixable — smol-toml decodes `1.0` to the same `1` as the integer, so a TOML float reads here as version 1 where the reference calls it malformed. Recorded in `docs/crate-routes.md` → "Where it knowingly differs from the CLI"; no emitter writes it.
- Rule 3's ordering test is ported, and mutation-tested: moving `rejectUnknownLockVersion` below `rejectUnknownKeys` turns exactly that test red and nothing else.
- Rule 4 is untouched — `rejectUnknownKeys` still refuses an unexpected key inside version 1.

The wording matches the CLI's sentence structure, with one deliberate difference: the SDK says *upgrade `@pipelex/sdk`* where the CLI says *upgrade pipelex (or your SDK)*. From this side that is the actionable half, and these no-verdict messages already diverge by construction — the CLI names the lock's path and the SDK has none, since it takes content.

### Upstream references

- `pipelex/codegen/lock.py` — `CODEGEN_LOCK_VERSION`, the `lock_version` field, `_reject_unknown_lock_version`, and the evolution policy in the module docstring. `encode_lock` writes the key **first**, before `crate_fingerprint`; `load_lock` gates the version **before** `model_validate`.
- `tests/unit/pipelex/codegen/test_lock.py` — the `_LEGACY_LOCK_WITHOUT_VERSION` fixture (`:18`) and the version tests (e.g. `:110`).
- `tests/unit/pipelex/codegen/test_emission.py` — regeneration over a legacy lock, and over a lock written by a newer codegen.
- `docs/under-the-hood/codegen-projections.md` § Lock — the policy in prose.

One upstream decision worth knowing, because it is visible behaviour: a lock whose version cannot be read is treated as *replaceable prior state* during regeneration, exactly like a corrupt one — `codegen types` overwrites it rather than failing, since the run has already rewritten every artifact with its own engine and the lock is purely derived. The cost is that pruning is skipped, so anything the newer engine emitted lingers and surfaces as an orphan on the very next check.

## While you are in here: U1's second-order effect

The strict header gate changed something beyond the verdict, and it is worth mirroring the *understanding* even where the code does not change. Upstream's regenerator uses the same parse to decide whether it owns a destination file. So a stamped file with an injected uncommented header line is now "unowned": the check reports it as an **orphan** advising *remove or regenerate*, while regeneration refuses to overwrite it. The refusal was kept deliberately — never clobber a file we cannot prove we own — and `remove` is the half of the advice that always applies. If this SDK ever grows a writer, it inherits the same seam.

## What is still open

Neither is a code change on this branch.

- **Publish `@pipelex/sdk`.** This is the whole remaining item, and per the finding above it no longer gates the pipelex release — but it is what makes the offline check exist for consumers at all, `lock_version` support included. Record the published version in `pipelex/wip/codegen/sdk-followups.md`, which is where the upstream side expects to read it.
- **Regenerate the vendored fixtures once pipelex releases.** They are pinned to the released `0.46.4`, which predates `lock_version`. Deliberately not refreshed from the current `dev`: that build writes `lock_version = 1` while still reporting `engine_version = "0.46.4"`, a combination no release will ever produce, so vendoring it would pin bytes that never existed in the wild. Verified in passing that the new emitter's output is otherwise byte-identical — same crate fingerprint, same artifact hashes, one added line — so the refresh is a one-line diff whenever it happens, and keeping a legacy-lock fixture afterwards is worth doing on purpose (rule 1).

## Not from upstream — landed on this PR

Two review threads on PR #31 belonged entirely to this repo rather than to the upstream landing. Both were fixed on 2026-08-19 and their threads are resolved; the first is recorded here because the parity reasoning behind it is worth not rediscovering.

- **`WINDOWS_DRIVE` missed U+2028 / U+2029** — fixed in `62bcf15`, which took the regex to `/^.:/su` (`WINDOWS_DRIVE`, `src/codegen-check.ts:584`). Verified against the reference while preparing this delivery: `PureWindowsPath("\u2028:models.py").drive` is `'\u2028:'`, so `validate_artifact_path` **rejects** it upstream, and U+2028 is `Zl` rather than `C` so the control-character gate does not catch it first. Without the `s` flag JavaScript's `.` excludes line terminators, so this module was accepting what the CLI rejects — a real parity divergence, with this module on the permissive side. Now pinned by the `line-separator-drive-prefixed` row of the path-rejection table (`tests/codegen-check.test.ts:571`, the table starting at `:563`), which is the only thing that goes red if the flag is reverted.
- **A duplicated CRLF test row** — the standalone clean-tree CRLF test was deleted in favour of the two-row `it.each` that covers CRLF and lone CR together (`tests/codegen-check.test.ts:224`). The standalone that remains at `tests/codegen-check.test.ts:248` is a different scenario — a hand edit *inside* a CRLF tree, pinning that normalizing line endings does not blunt the check itself — so it is not a leftover duplicate.

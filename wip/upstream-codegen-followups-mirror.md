---
delivered_from: workspace `wip/inbox/2026-08-19-pipelex-sdk-js-codegen-lock-version.md`
delivered_on: 2026-08-19
upstream_branch: `pipelex` → `feature/Codegen-followups` (committed, **unpushed and unreleased**)
---

# Mirroring the upstream codegen follow-ups

`pipelex` has landed all five upstream items this PR's review surfaced (U1–U5 in [`pr-31-review-notes.md`](pr-31-review-notes.md)). This is what that means for `src/codegen-check.ts`, and — the part that matters most — **which direction each one travels in**, because they do not all travel the same way.

The invariant that governs everything below is the module's own: a verdict computed here must equal the one `pipelex codegen check` computes over the same bytes. That is why the SDK must never be *stricter* than the CLI, and equally why it must not be *less tolerant* of a format the CLI has started writing.

| Upstream item | What landed there | What this repo does | Direction |
|---|---|---|---|
| U1 — uncommented lines inside the stamp header | header lines must all carry the comment prefix; the `else raw_line.strip()` fallback is gone | mirror the two-line patch in `pr-31-review-notes.md` §1 | **after** a pipelex release |
| U5 — `NaN` / `Infinity` in the stamp's `options` | `json.loads` now refuses the non-standard JSON constants | nothing — `JSON.parse` already refuses them; this closed a gap where the SDK was the stricter side | already aligned |
| U2 — drift ordering | both loops unified on the plain full-string sort; `_find_orphans` now sorts its result | **nothing** — upstream converged toward the comparator this module already used | resolved upstream |
| U4 — CRLF artifacts on Windows | `save_text_to_path` writes `newline="\n"` everywhere | nothing — this module already normalizes newlines before hashing | invisible here |
| U3 — the lock format has no version | every lock now opens with `lock_version = 1` | **teach the reader the key, and ship it first** | **before** a pipelex release |

## U3 is the blocker, and it is the one that inverts

`src/codegen-check.ts` rejects unknown lock keys, deliberately, mirroring pydantic's `extra="forbid"`. So the moment a pipelex release starts writing `lock_version`, every consumer pinned to the current `@pipelex/sdk` gets a hard `CodegenLockError` no-verdict in CI — not a drift, not a warning. That is precisely the failure U3 was filed to eliminate, and shipping the fix in the wrong order would cause it.

**An `@pipelex/sdk` that tolerates `lock_version` must be published before the pipelex release that writes it.** Upstream is committed but unreleased, so the window is open — but it is the whole remaining critical path on both sides.

### The four rules to mirror

1. **A lock with no `lock_version` key is version 1 by definition.** Nothing on disk needs migrating; every lock written before the field existed is already conformant. Keep at least one vendored fixture without the key to pin this.
2. **A reader refuses any version it does not know, and says which side to upgrade.** A version *greater* than the one it reads means "written by a newer Pipelex codegen — upgrade". Anything else (`0`, negative, non-integer, boolean) is malformed, not a future version. Upstream had to exclude booleans explicitly, because Python's `bool` is an `int` subclass and `True == 1`; whatever the JS equivalent hazard is, cover it.
3. **The version is read *before* the key set is validated.** This is the load-bearing ordering and the easiest thing to get wrong. Otherwise `rejectUnknownKeys` fires on a key a future writer was entitled to add and reports an opaque shape complaint instead of naming the version — the unactionable no-verdict U3 exists to remove. Upstream pins this with `test_a_newer_lock_version_is_refused_even_when_it_carries_unknown_keys`, and mutation-testing it (moving the gate back after validation) turns it red. Port that test.
4. **Strictness *within* a known version stays.** `extra="forbid"` is unchanged upstream; `rejectUnknownKeys` should be too.

Keep the message wording aligned with the CLI's, so a user who hits this in either toolchain reads the same sentence.

### Upstream references

- `pipelex/codegen/lock.py` — `CODEGEN_LOCK_VERSION`, the `lock_version` field, `_reject_unknown_lock_version`, and the evolution policy in the module docstring. `encode_lock` writes the key **first**, before `crate_fingerprint`; `load_lock` gates the version **before** `model_validate`.
- `pipelex/tests/unit/pipelex/codegen/test_lock.py` — the `_LEGACY_LOCK_WITHOUT_VERSION` fixture and the version tests.
- `pipelex/tests/unit/pipelex/codegen/test_emission.py` — regeneration over a legacy lock, and over a lock written by a newer codegen.
- `pipelex/docs/under-the-hood/codegen-projections.md` § Lock — the policy in prose.

One upstream decision worth knowing, because it is visible behaviour: a lock whose version cannot be read is treated as *replaceable prior state* during regeneration, exactly like a corrupt one — `codegen types` overwrites it rather than failing, since the run has already rewritten every artifact with its own engine and the lock is purely derived. The cost is that pruning is skipped, so anything the newer engine emitted lingers and surfaces as an orphan on the very next check.

## While you are in here: U1's second-order effect

The strict header gate changed something beyond the verdict, and it is worth mirroring the *understanding* even where the code does not change. Upstream's regenerator uses the same parse to decide whether it owns a destination file. So a stamped file with an injected uncommented header line is now "unowned": the check reports it as an **orphan** advising *remove or regenerate*, while regeneration refuses to overwrite it. The refusal was kept deliberately — never clobber a file we cannot prove we own — and `remove` is the half of the advice that always applies. If this SDK ever grows a writer, it inherits the same seam.

## Not from upstream — still open on this PR

Two review threads on PR #31 are unresolved and belong entirely to this repo; neither is affected by the upstream landing:

- **`WINDOWS_DRIVE = /^.:/u` misses U+2028 / U+2029** (`src/codegen-check.ts:488`). Verified against the reference while preparing this delivery: `PureWindowsPath("\u2028:models.py").drive` is `'\u2028:'`, so `validate_artifact_path` **rejects** it upstream, and U+2028 is `Zl` rather than `C` so the control-character gate does not catch it first. JavaScript's `.` excludes line terminators, so this module accepts what the CLI rejects — a real parity divergence, with this module on the permissive side. The reviewer's one-character suggestion (`/^.:/su`) is correct.
- **A duplicated CRLF test row** (`tests/codegen-check.test.ts:224`) — the `it.each` CRLF case and the standalone CRLF test exercise the same mutation. Cosmetic.

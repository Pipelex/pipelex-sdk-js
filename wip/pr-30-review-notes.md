# PR #30 review triage — deferred items

Triage of the unresolved `cubic-dev-ai` review threads on [PR #30](https://github.com/Pipelex/pipelex-sdk-js/pull/30) (the `v0.12.0` release PR). Most threads were false positives and were replied to and resolved on the PR; two confirmed-but-secondary items are recorded here rather than fixed on the release branch. Both PR threads are deliberately left **open**.

For the record, the two items that *were* fixed on the branch: the stale preflight callout and the out-of-order dated sections in `crate-routes-resume.md` (an edit `49feca9` had already applied to the HTML twin but missed on the Markdown), and a variable rename in `docs/crate-routes.md` where a `resolve()` example named its result `crate` instead of `result`.

## 1. `Makefile` — an exported-but-empty `PIPELEX_E2E_BASE_URL` skips the localhost fallback

**Reporter:** `cubic-dev-ai` (P2). **Location:** `Makefile:83`.

**The finding, confirmed.** GNU make's `?=` is equivalent to `ifeq ($(origin V),undefined)`, and a variable that is exported-but-empty has origin `environment`, not `undefined`. So the assignment never fires, the `$(shell)` never runs, `.env` is never consulted, and the `${VAR:-http://localhost:8081}` fallback inside that shell never gets a chance. Verified against a faithful copy of the recipe:

```
### 1) unset (no .env)                       -> http://localhost:8081
### 2) exported EMPTY                        -> ""              <-- the hole
### 3) exported nonempty                     -> the env value
### 4) command-line override                 -> the cmdline value
### C) .env has a value, env exported EMPTY  -> ""              <-- .env silently ignored
```

Case C is the one that actually stings: the developer's `.env` names a perfectly good target and make refuses to use it. Note the `.env`-side empty case is already handled correctly — `PIPELEX_E2E_BASE_URL=` *inside* `.env` still yields the localhost default, because there the `$(shell)` does run and `:-` treats empty as unset. The hole is exclusively the shell-environment path.

**Why it was deferred, not fixed.** Nothing breaks. The run fails closed and loud, before any suite executes:

```
$ PIPELEX_E2E_BASE_URL= make test-e2e
✗ No pipelex-api reachable at
make: *** [test-e2e] Error 1
```

`curl` exits 3 (`URL rejected: No host part in the URL`), the `||` branch fires, `exit 1` aborts ahead of `npm run test:e2e`, and the message names the variable to fix. There is a second, independent backstop too: even bypassing make entirely, `PipelexApiClient` refuses to construct on an empty base URL (`src/client.ts:274-279` → `PipelineRequestError: Invalid API base URL ""`). So there is no reachable path on which a suite runs against an empty target — contrary to the thread's claim that "the preflight and all suites run with an empty target".

Against that, the fix carries a real cost: `:=` on a target-specific variable is expanded at **parse time**, so the `.env`-sourcing `$(shell)` would fire on *every* make invocation — `make check`, `make help`, `make -n` of an unrelated target. That is one extra `sh` fork per make run (negligible in wall-clock, but a behaviour change to the whole file). Landing that as a drive-by on a release PR is not the right moment. (Conversely it *removes* a current redundancy: `?=` creates a recursive variable, so `.env` is sourced ~3× per `test-e2e` today.)

**The argument for landing it later.** This PR already made the identical empty-string defense on the TypeScript side — `process.env.PIPELEX_API_KEY ?? "e2e-test"` became `|| "e2e-test"` in `tests/e2e/build.e2e.ts` and `tests/e2e/tools.e2e.ts`, precisely so an empty string falls through to the default. The Makefile is the last hole in a defense the authors deliberately applied everywhere else.

**Ready-to-apply change.**

```diff
-test-e2e: export PIPELEX_E2E_BASE_URL ?= $(shell $(DOTENV) printf '%s' "$${PIPELEX_E2E_BASE_URL:-http://localhost:8081}")
+test-e2e: export PIPELEX_E2E_BASE_URL := $(if $(strip $(PIPELEX_E2E_BASE_URL)),$(PIPELEX_E2E_BASE_URL),$(shell $(DOTENV) printf '%s' "$${PIPELEX_E2E_BASE_URL:-http://localhost:8081}"))
```

Verified to preserve the documented precedence across all eight cases (shell env wins, then `.env`, then localhost; the `make test-e2e PIPELEX_E2E_BASE_URL=…` command-line override still wins).

Three things to get right when applying it:

- **Correct the comment block at `Makefile:76-80` in the same edit.** It currently says "`?=` is what enforces it" — with this change the enforcement moves to `$(if $(strip …))` and `?=` no longer appears.
- **Do not** also move the slash-stripping onto the assignment. The `E2E_TARGET` comment at `Makefile:85-88` becomes partly stale (with `:=` the shell-env value *is* re-assigned), but point-of-use stripping stays correct either way, and changing it is scope creep.
- **Do not** extend the guard to the `PIPELEX_API_KEY` line below. Empty is a legitimate value there (the local unauthenticated runner), the TS side already absorbs it via `|| "e2e-test"`, and the worst case is a 401 that says so.

**Testing.** Not practically unit-testable, and not worth inventing a harness for: make variable semantics need a real `make` subprocess with a controlled environment and a controlled `.env`, and this repo has no shell-test harness. The corrected comment block is the right record. The reproduction is two commands, better suited to a PR description than a test file:

```
PIPELEX_E2E_BASE_URL= make test-e2e                               # must fall back to localhost
make test-e2e PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com    # must still win
```

## 2. `wip/prepare-inputs-explicit-envelope-todos.md` — residual unchecked boxes in an archived doc

**Reporter:** `cubic-dev-ai` (P3). **Location:** `wip/prepare-inputs-explicit-envelope-todos.md:161` (and `:140`, `:147`, `:149`).

**The finding, confirmed — but inverted from how it was reported.** The thread reads the unchecked boxes as evidence that the "All phases below are complete" header overclaims. It is the other way round: the header is substantively **true**, and the boxes are stale snapshots taken before `/release` ran. Each one, checked against the repo:

| Marker | Claim | Reality |
| --- | --- | --- |
| `[~]` CHANGELOG deferred to `/release` (`:140`) | entry not yet added | **Done.** `CHANGELOG.md` `## [v0.9.0] - 2026-07-24` → `### Fixed` carries it, in expanded form. |
| `[ ]` Bump version via `/release` (`:147`) | version not bumped | **Done.** v0.9.0 shipped 2026-07-24; `package.json` is now `0.12.0`. |
| `[ ]` Decide: internal vs export a helper (`:161`) | decision open | **Decided — internal**, as the doc itself recommended. `isExplicitEnvelope` is declared without `export` at `src/prepare-inputs.ts:107`, and `src/index.ts` exports only the `PrepareInputsRequest` / `PreparedInputs` types. |
| `> **Not committed.**` (`:149`) | work uncommitted | **False now.** The source landed as `910f4d2`, the docs/wip as `904e179`; both are ancestors of `origin/dev` and `HEAD`. |

**Why it was deferred.** Purely cosmetic, in a file under `wip/` — explicitly a non-release-facing scratch/handoff medium (the workspace convention is that changelogs ignore `./wip/`). Three of the four possible wrong actions (re-add the changelog entry, re-bump, re-commit) collapse on first contact with the repo. The only one with any half-life is the internal-vs-export box, and it sits under a heading that already says "do NOT let it block the core fix". Not worth churn on a release branch.

**Ready-to-apply change** — four in-place edits, no restructuring, to fold into whatever next touches this file on `dev`:

1. `:140` — `[~]` → `[x]`, append: **Shipped in v0.9.0** — the entry below landed (expanded) under that heading.
2. `:147` — `[ ]` → `[x]`, append: Shipped as v0.9.0 (minor, as predicted).
3. `:161` — `[ ]` → `[x]`, append: **Decided: kept internal.** `isExplicitEnvelope` is unexported in `src/prepare-inputs.ts`; no helper on the public surface.
4. `:149` — replace the `> **Not committed.**` blockquote with: **Committed and shipped.** The code landed in `910f4d2`, the docs/handoff in `904e179`, released as v0.9.0. The MCP-side follow-ups are tracked in `pipelex-mcp`, not here.

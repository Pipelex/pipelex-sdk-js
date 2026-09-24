---
status: active
item: L-260924-bdb054
---

# Plan — the Codex hook checks the file a shell patch wrote

Design: [`design.md`](./design.md). This tracker carries the phases, the decisions taken while implementing, and the checkpoint hand-offs. It records what cannot be re-derived from the tree, never whether something is committed, pushed or passing right now.

## Scope

One pull request against `dev` in `pipelex-sdk-js`, from `feature/Follow-cd-before-resolving` in the worktree `_pipelex-sdk-js--follow-cd-before-resolving`, titled `feature/Follow-cd-before-resolving · L-260924-bdb054` with `Closes L-260924-bdb054` in its body. It changes how the hook bundle's Codex path finds the files a patch touched (design Decisions 1 to 6), adds `docs/hook-bundle.md`, and adds a changelog entry under Unreleased. No version bump and no release: the bundle is vendored from a source checkout, not from the npm tarball.

Out of scope, and why: re-vendoring the bundle into `pipelex-plugins`, flipping its test and rewriting its `docs/hooks.md` paragraph belong to that repository, and are one ledger item blocked by this one (Phase 5). The patch Codex applies in process, which fires no hook, needs an upstream Codex change and is not touched.

## Phase 0 — ratification

- Louis answers the three open questions at the end of `design.md`. The phases below are written against the recommended answers; cutting Decisions 5 and 6 removes Phase 3 and moves its work to a new item.
- On ratification: flip both documents to `status: active`, record the answers and the date under "Decisions log" below, and retype the item if question 2 says so.

## Phase 1 — patch sections and the payload anchor

Files: `src/hooks/patch-envelope.ts` (new), `src/hooks/check-core.ts`, `src/hooks/claude-mthds-check.ts`, `tests/hooks/patch-envelope.test.ts` (new), `tests/hooks/check-core.test.ts`.

- `patch-envelope.ts`: `readPatchSections(text)` returns each `Add File`, `Update File` (with its optional `Move to`) and `Delete File` section with its offset in the text and its added lines, and `patchTargets(sections)` computes the `.mthds` files that survive the patch, in the order of design Decision 2. The header lines recognised stay today's three.
- `check-core.ts`: `extractCodexMthdsTargets(stdinJson, processCwd)` replaces `extractCodexMthdsFiles`. In this phase it reads every payload as the patch tool's, anchored on the payload's `cwd` when it is absolute (Decision 1), and returns absolute paths with their added lines.
- `claude-mthds-check.ts`: `resolveTargets` calls it for `codex`. Behaviour for the patch tool is unchanged apart from the anchor.
- Tests: the section reader on every header kind, a move, a delete, a file named twice, a section with no added line, and text with no envelope; `extractCodexMthdsTargets` on the anchor (absolute `cwd`, missing `cwd`, relative `cwd`). The existing test "extracts Update/Add/Move-to targets, deduped" changes its expectation: `a.mthds`, updated and then moved to `c.mthds`, is no longer a target.

## Phase 2 — the shell reading

Files: `src/hooks/shell-script.ts` (new), `src/hooks/check-core.ts`, `tests/hooks/shell-script.test.ts` (new), `tests/hooks/check-core.test.ts`.

- `shell-script.ts`: the lexer and the directory walk of design Decision 3. `readShellScript(script, sessionDir)` returns either "unparsed" or a reading whose `directoryAt(offset)` answers a directory, `unknown`, or `outside`. The lexer handles single and double quotes, `$'…'`, backslash escapes and line continuations, `$( … )` scanned recursively as a nested script, `${ … }`, backticks, comments, the separators, `(` and `)`, redirections with an optional descriptor number, here-strings, and heredocs (`<<`, `<<-`, quoted or bare delimiters, several on one line, each body owned by the command that opened it).
- `check-core.ts`: for `tool_name: "Bash"`, `extractCodexMthdsTargets` finds the sections in the script, places each by `directoryAt` its header's offset, resolves its relative paths against that directory, and lists as unplaced the relative paths under an unknown directory or an unparsed script (Decision 4). A header outside every command is dropped.
- Tests, table-driven in `shell-script.test.ts`, one row per construct of the design's table, and at least these scripts: no `cd`; `cd sub;`, `cd sub &&` and `cd sub` then a newline; an absolute `cd`; `cd a && cd b`; a quoted operand holding a space; `cd "$X"`, `cd`, `cd -`, `cd ~/x`; `cd "$X" && cd /abs`, which is known again; `(cd sub && apply_patch …); apply_patch …`, placing the two patches differently; `cd sub | cat` and `cd sub &`; `pushd sub`, `eval …`, a function definition; `cd sub 2>/dev/null &&`; a heredoc body holding a line `cd other`, which is not followed; `# cd other`; `apply_patch "$(cat <<'EOF' … EOF\n)"` after a `cd`; `apply_patch '*** Begin Patch …'` as one quoted argument; `cat <<'EOF' | apply_patch`; two patches with a `cd` between them; `<<-EOF` with a tab-indented delimiter; an unterminated quote and an unbalanced `)`, both unparsed. In `check-core.test.ts`: a `Bash` payload for each outcome (placed, unplaced, dropped), and an `apply_patch` payload whose patch text contains `cd sub` lines, which is read as today.

### Checkpoint A — the reading is right

The lexer is the part most likely to be wrong in a way no later phase notices, so the branch stops here for a review before the content check builds on it.

- Record under "Checkpoint log": the completed phases, the decisions taken while implementing, anything in the design that turned out wrong, and the SHA the checkpoint was taken at.
- `make check` and `make test` in the worktree.
- `/rev`.

## Phase 3 — the content check and the note

Files: `src/hooks/check-core.ts`, `src/hooks/claude-mthds-check.ts`, `tests/hooks/check-core.test.ts`.

- `check-core.ts`: `carriesAddedLines(content, addedLines)`, the in-order trimmed comparison of design Decision 5, and `uncheckedShellPatchNote(paths)`, the note of Decision 6 as a `context` outcome.
- `claude-mthds-check.ts`: for a target from a `Bash` payload, `checkOneFile` runs the content check on the content it already reads, and a target that fails it, or does not exist, joins the unplaced paths. `main` appends the note to the outcomes when the list is not empty, so the existing merge decides what is sent.
- Tests: the comparison (in order, out of order, trailing whitespace, blank added lines, no added lines, CRLF content); the note's text and its merge under a block from another file.

## Phase 4 — documents and verification

Files: `docs/hook-bundle.md` (new), `docs/architecture.md`, `CHANGELOG.md`.

- `docs/hook-bundle.md`: which file the hook checks on each platform, and for Codex the anchor, the shell reading with its table, the content check, the note and the known limits, written for a reader who has not seen this design. `docs/architecture.md`'s "Hook bundle" section links to it.
- `CHANGELOG.md`, under Unreleased: the Codex hook follows the shell's working directory before resolving a shell patch's relative paths, no longer checks or reformats a same-named file the patch did not touch, and says when it could not check a file.
- Verify against the built bundle, not only the unit suites: `npm run build:hook`, then rerun the two crafted payloads of the design's verification section against `dist-hooks/check.mjs`. The first must now block on `project/sub/broken.mthds`. The second must block on `project/sub/broken.mthds` and leave `project/broken.mthds` byte for byte unchanged. Add a third run with no `cd` in the script and a note expected, standing in for the `workdir` route: the broken file only in `project/sub/`, a valid file at `project/broken.mthds` that does not hold the patch's added lines. Record the outputs under "Checkpoint log".
- `make check` and `make test`.

### Checkpoint B — ready for the pull request

- Record under "Checkpoint log" as at Checkpoint A, with the verification outputs.
- `/rev`, then open the pull request.

## Phase 5 — the `pipelex-plugins` follow-up

- File one item owned by `pipelex-plugins`, `--blocked-by L-260924-bdb054 --discovered-from L-260924-bdb054`, for the work in the design's "Downstream" section: re-vendor with `make vendor-hook` once this lands on `dev`, flip `test_a_relative_path_in_a_codex_patch_is_read_from_the_session_directory`, add the wrong-file and note cases to `tests/unit/test_hook_commands.py`, and rewrite the paragraph "A relative path in a patch is read from the session's directory" in `docs/hooks.md`. Name its id here.
- After the merge, `/ledger-land` closes L-260924-bdb054 with the merge as evidence, which releases the follow-up.

## Decisions log

- **2026-09-25, ratification (Phase 0).** Louis answered the design's three open questions, each with the recommended answer. The content check and the note (design Decisions 5 and 6) stay in this item, so Phase 3 stands. The item is retyped from `feature` to `bug`, at severity `normal`, because the hook rewrote a file the agent had not edited. The note keeps the wording of Decision 6 and is sent for relative paths only. Both documents moved to `status: active`.
- **2026-09-25, the Checkpoint A review (round 1, at `8b1729e`).** Four findings were confirmed against real bash with crafted scripts, and each changed the reading. Design Decision 3 and its table now describe the result.
  - **A header is placed by the patch command that reads it, not by whichever command holds it.** A patch kept in a variable and applied after a `cd`, staged in a file, run through `bash -c` or `eval`, or fed by a substitution that itself moves (`apply_patch "$(cd sub; cat <<'EOF' …)"`) was placed in a confident wrong directory. The text of a command that is neither `apply_patch` nor feeding one is now unknown.
  - **`if`, `case` and the loops are parsed as compound commands**, so a pipeline or background list holding one is read as the subshell it is, rather than `|` or `&` binding only to `fi` or `done`.
  - **Exclusive paths no longer chain.** `cd sub || cd other` and an `if` whose branches `cd` to different places used to yield `sub/other`. Where only one of several paths runs, the directory is now kept only when they all agree. A loop whose passes start in different directories is read from an unknown one. An unknown directory is a distinct value each time, so the walk can tell that a command moved the shell even when it knows neither where from nor where to.
  - **Pipelines and background lists were refined further** after checking bash 3.2 and zsh 5.9 on this machine: a background list never moves the shell, and neither does any pipeline member but the last. So `cd sub | cat` and `cd sub &` now keep the directory rather than making it unknown.
  - **Envelopes fold separately.** The sections of one envelope still apply in order, but across the envelopes of a script, which may run in other directories or in exclusive branches, a file survives when any envelope leaves it. So a delete in one no longer hides an edit in another, whether the directories are known or not. Each target carries every envelope's added lines and whether some section removes it, which Phase 3 needs to tell a file the patch deleted from a file it could not find.
  - **The reading is bounded.** A directory longer than `PATH_MAX` is unknown, which keeps thousands of chained relative `cd`s linear. The walk also has a budget proportional to the script's length, so loops nested deep enough to cost exponential time make the script unparsed.
  - **Decision 5 is tightened for Phase 3.** The verifier showed that every residual misplacement reaches a wrong file through a section that adds no line (a pure deletion or a bare rename), which Decision 5 accepted unconfirmed. The `pipelex-plugins` session working L-260924-736ae2 asked, independently, that the hook never format a shell patch's file it cannot confirm. So a relative target from a `Bash` payload whose sections add no line gets the note instead of a check. Formatting stays on for a confirmed file.
  - **`pipelex-plugins` coordination.** On `feature/Review-fix-first`, that repository's Codex wrapper now runs the bundle from an empty directory for a `Bash` payload, so that only absolute paths are checked. This bundle anchors on the payload's `cwd` (Decision 1), which bypasses the empty directory, so the wrapper change becomes inert once the bundle is re-vendored. L-260924-dd7bf2 now also covers removing it.

## Checkpoint log

### Checkpoint A, taken at `df1dfb8`

Phases 1 and 2 are complete: `src/hooks/patch-envelope.ts` reads the envelope as sections and computes the surviving files, `src/hooks/shell-script.ts` lexes a `Bash` script and places each offset, and `extractCodexMthdsTargets` in `src/hooks/check-core.ts` replaces `extractCodexMthdsFiles`, returning the targets and the unplaced relative paths. The entry point still checks only the placed targets; the content check and the note are Phase 3. `make check` and `make test` passed at this SHA.

Decisions taken while implementing:

- **Pipelines and background lists are read as the subshells they are.** Each member of a pipeline starts in the directory the pipeline starts in, and the commands of a list sent to the background follow each other as usual. The directory after either becomes unknown only when something inside it changed the directory, so `ls | cat` no longer costs the rest of the script its directory, and `cd sub | apply_patch …` places the patch in the directory the pipeline started in, which is right in both bash and zsh. The design's table said only that a `cd` there makes the directory unknown, which still holds for everything after it.
- **`{ … }` is read as a group rather than flattened**, so a group in a pipeline or in the background gets the subshell reading above. The bodies of `if`, `while`, `until`, `for` and `case` stay flattened, as the design says.
- **`case` is followed:** while a `case` is open in the current list, a `)` ends a pattern instead of closing a scope, so a `cd` in a branch is followed like any other.
- **More of the command name is recognised:** leading assignments (`CDPATH= cd sub`), `builtin cd`, `command cd` and a quoted `"cd"` are all read as `cd`. An unknown option (`cd -e sub`) and zsh's directory stack (`cd +1`) make the directory unknown.
- **An unterminated heredoc is read to the end of the script**, as bash does, rather than making the script unparsed: its owner is still known.
- **A header held by no command cannot come from a script the reader lexes**, since every non-blank line is either some command's text or a heredoc body. The drop in `extractCodexMthdsTargets` stays as a guard, and `outside` is tested at the level of `directoryAt`.

Nothing in the design turned out wrong. The lexer was fuzzed with 200,000 random scripts over its special tokens, and none hung or threw past its guard. A script with thousands of chained relative `cd`s is quadratic, but only through the length of the path it builds.

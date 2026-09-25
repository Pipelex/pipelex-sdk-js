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
- Filed as L-260924-dd7bf2 on 2026-09-24. On 2026-09-25 its scope grew to cover removing the wrapper's empty-directory run for `Bash` payloads, which `pipelex-plugins` added on `feature/Review-fix-first` as a stopgap and which this bundle's payload-`cwd` anchor makes inert.

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

- **2026-09-25, the Checkpoint B review (round 1 again, at `a06681b`).** The branch had grown past the review ladder's growth line since round 1, so the pass ran at the `open` bar. cubic and the code-review subagent reviewed it; both Codex runs failed at launch on the account's usage limit. One verifier confirmed six findings against real bash and the built bundle, and each changed the code. Design Decisions 3 to 7 and its known limits describe the result.
  - **What runs only after a failure starts from an unknown directory once the shell moved.** `elif`, `else`, an `until` loop's body and what follows a `while` loop were started where a moving condition succeeded, so `if cd sub; then :; else apply_patch …` placed the patch in `sub` although the shell was still in the session directory. The walk now carries, for each list, where it leaves the shell, the status it exits with, and whether it moved, so these paths follow the rule `\|\|` already had. `!` is recorded rather than dropped, so a negated `cd` fails on the followed path.
  - **The added lines are compared as the shell passed them.** A patch in double quotes carried `\"` where the file got `"`, and one in an unquoted heredoc lost its `$` references, so a correctly placed file never confirmed. The reading now records the quoting of every quoted string and heredoc body, and the lines are unescaped accordingly, with lines holding an expansion left out.
  - **Two bash forms no longer make a script unparsed:** a process substitution as a redirection's target (`done < <(find …)`, `exec > >(tee log)`), and a `[[ … ]]` whose expression holds parentheses, such as a regex after `=~`.
  - **An absolute path in text no patch command reads is confirmed.** A patch the script only stored in a file named `/repo/a.mthds`, and the hook formatted that file in place although nothing had written it. Such a path, and any absolute path in an unparsed script, is now checked only when its file carries the patch's added lines, and dropped without a note otherwise. The placement distinguishes `unread` text from text a patch command reads in an unknown directory.
  - **The note survives an engine that cannot load.** `main` returned before appending it.
  - **Deferred: a failed guard before `&&`.** `[[ -d build ]] && cd build; apply_patch …` is read as moving into `build`. When the guard fails, the content check skips the file there and the note names it; reading the guard as either path would turn the common, successful case into a note too. It is a known limit in the design and in `docs/hook-bundle.md`.
- **2026-09-25, the Checkpoint B review (round 2, at `7033675`), on the pull request.** The pass ran at the `defects` bar. cubic, both Codex runs and the code-review subagent reviewed it, and one verifier confirmed three findings against real bash and bundles built from the branch and from `dev`. Louis chose to fix all three. Design Decisions 2, 4, 5 and 6 and its module list describe the result.
  - **Each file is read when its check starts (a critical).** The targets carried the content read at selection into the lint and the format write-back, across the engine load and every earlier file's validate call, so an edit made meanwhile was overwritten with the older text and a file deleted meanwhile was recreated. `dev` read the file inside `checkOneFile`, and it does so again.
  - **A patch passed as a quoted argument is its own envelope.** `apply_patch '*** Begin Patch` does not start a line, so every such patch of a script shared one envelope and a delete in a branch that did not run hid another's edit, with neither a check nor the note. An `*** End Patch` line now starts a new envelope too.
  - **An absolute path a patch command reads is checked unless its file lacks the patch's added lines.** A patch in a branch the script did not take, or in a function it never called, reformatted a file nothing had written, as `dev` does. The note still covers relative paths only, as ratified.
- **2026-09-25, the Checkpoint B review (round 3, at `afa352b`), on the pull request.** Round 2 fixed a critical, so the pass ran at the `necessity` bar. cubic, both Codex runs and the code-review subagent reviewed it; the code-review skill wrote a probe test into the checkout and removed it, and the tree was found clean afterwards. One verifier confirmed the two admitted findings against real bash and bundles built from `afa352b` and `7033675`. Louis chose to fix both and defer the rest. Design Decision 5 and its known limits describe the result.
  - **The added lines are read through the quotes a line closes and reopens.** A single-quoted patch writing an apostrophe as `'\''` was compared as written, and a line ending in a backslash in double quotes or an unquoted heredoc was compared apart from the line the shell joined it to. Round 2's rule for absolute paths turned either mismatch into a file dropped with no check and no note. `linesAsRead` now follows the quote switches within a line, and when a line ends in other quoting than it began in, or in a joining backslash, gives no line of the section, which refutes nothing.
  - **Deferred, unverified, as known limits in the design and in `docs/hook-bundle.md`:** a delete in another branch hiding a missing file's note, a header path holding an expansion, an unreached pure deletion still checking its absolute file, and a pipeline member after the patch command read as feeding it.

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

### Checkpoint B, taken at `9be6faa`

Phases 3 and 4 are complete on top of the round-1 fixes (`76ae387`). `selectCodexTargets` in `src/hooks/check-core.ts` decides which of a Codex patch's targets are checked. A target a shell patch named by a relative path must carry the added lines of some section that wrote it (`carriesAddedLines`), and a section that adds no line confirms nothing. The paths it could not place, confirm or find, unless the patch removed them, go into `uncheckedShellPatchNote`. The entry point reads each file once, loads the engine only when there is a file to check, and appends the note before the merge. `docs/hook-bundle.md` describes the reading for a reader who has not seen the design, `docs/architecture.md` links to it, and `CHANGELOG.md` has the entry under Unreleased. `make check` and `make test` passed at this SHA.

Decisions taken while implementing: the round-1 entry under "Decisions log" above. The design's Decisions 3, 5 and 6 and its known limits were updated to match, and nothing else in it turned out wrong. After the round-1 fixes, a relative-`cd` chain past `PATH_MAX` is unknown and the walk has a budget, so reading stays linear. 300,000 fuzzed scripts over the lexer's tokens and the new keywords neither threw nor took longer than a millisecond each, and a 50,000-line script reads in about 0.2 s.

Verification against `dist-hooks/check.mjs` built at this SHA, with `PIPELEX_API_KEY` unset so that only the local stages ran. The payload's `cwd` was a `project/` directory. `broken.mthds` is a method whose pipe type the patch changes to `NotAPipe`, and the session directory's `valid.mthds` is a valid method that the formatter would rewrite:

1. `cd sub; apply_patch <<'PATCH' …`, with the broken file only in `project/sub/`: the hook blocked on `project/sub/broken.mthds` with `[schema/error] "NotAPipe" is not one of [...] (pipe.echo.type, line 13, col 8)`.
2. `cd sub && apply_patch <<'PATCH' … PATCH` then `echo applied`, with the broken file in `project/sub/` and the valid file at `project/broken.mthds`: the same block on `project/sub/broken.mthds`, and `project/broken.mthds` kept its SHA-1 `42ccfb14`.
3. The same patch with no `cd`, standing in for `exec_command`'s `workdir`, with the same two files: no block, the note "The .mthds hook did not check `broken.mthds`: it could not confirm which file this shell command patched. …" as `additionalContext`, and `project/broken.mthds` still `42ccfb14`.
4. A pure deletion after `cd sub`, with valid files in both directories: the note, and `project/broken.mthds` still `42ccfb14`.
5. Control: an `apply_patch` tool payload with a pure deletion, the hook run from an empty directory: it blocked on the session directory's broken file, anchored on the payload's `cwd`, with no content check.

---
status: active
item: L-260924-bdb054
---

# The Codex hook checks the file a shell patch wrote, or says it could not

## Where this comes from

The `.mthds` post-edit hook is built here (`src/hooks/`, bundled into `dist-hooks/check.mjs` by `npm run build:hook`) and vendored into `pipelex-plugins` as a static hook asset. Fix 6 of L-260924-736ae2 (`pipelex-plugins` `92a4502`, on `feature/Review-fix-first`) widened the Codex matcher to `^(apply_patch|Bash)$`, so the hook now also receives patches that a Codex model runs through the shell, which Codex reports as `Bash` with the whole script in `tool_input.command`. The implementer of that fix found that the bundle resolves such a patch's relative paths against the session directory, whatever directory the script moved to before running `apply_patch`, and filed this item. It proposed following a leading `cd <dir> &&` or `cd <dir>;` as an optional improvement.

This document is the `@pipelex/sdk` design for the item. It goes further than the proposal, because the verification below shows that following `cd` alone leaves the harmful half of the defect in place.

## Verification, 2026-09-24

The item's claims hold against `dev` at `f454fc0`, and against the Codex source at `codex-rs` `553df1c691`.

- **The bundle resolves against its own working directory.** `resolveTargets` in `src/hooks/claude-mthds-check.ts` resolves every path `extractCodexMthdsFiles` returns with `resolvePath(process.cwd(), raw)`, whatever the payload's `tool_name`.
- **That directory is the session's.** Codex runs a hook command with its working directory set to the turn's `cwd` (`hooks/src/engine/command_runner.rs:218`, called with `request.cwd` from `hooks/src/events/post_tool_use.rs:107`), and the same value is serialized as the payload's `cwd` (`post_tool_use.rs:158`).
- **A `Bash` payload carries the script and nothing else.** `tool_input` is `{ "command": <cmd> }` (`core/src/tools/context.rs:398-402`), where the command is the model's `cmd` argument verbatim (`core/src/tools/handlers/unified_exec/exec_command.rs:251`). The `workdir` argument of `exec_command` is not in the payload, so a script run in another directory by that argument cannot be told from one run in the session directory.
- **The `apply_patch` program resolves against the shell's directory.** The standalone `apply_patch` that Codex puts on the `PATH` reads the patch from its single argument or from stdin, and applies it relative to its own working directory (`apply-patch/src/standalone_executable.rs:12-51`), which is wherever the script has moved to.

Both failure modes were reproduced with crafted payloads against `dist-hooks/check.mjs` built from `dev`, with `PIPELEX_API_KEY` unset so that only the local stages ran. The payload's `cwd` was a `project/` directory, and the script patched `broken.mthds` after moving into `project/sub/`.

- **The edited file goes unchecked.** With `cd sub; apply_patch <<'PATCH' … PATCH`, `project/sub/broken.mthds` holding a schema error, and no `project/broken.mthds`, the hook printed nothing and exited 0. The same patch without the `cd`, with the broken file at `project/broken.mthds`, blocked with the schema diagnostic, which is the control.
- **Another file is checked, and rewritten.** With `cd sub && apply_patch <<'PATCH' … PATCH && echo applied`, the broken file in `project/sub/`, and a valid but unformatted `project/broken.mthds` the patch never touched, the hook passed silently and reformatted `project/broken.mthds` in place: its SHA-1 went from `b8cc748e` to `91aed4e8`.

The second reading is not an improvement left undone: a hook rewrote a file the agent did not edit. And the `workdir` route, which the item rightly calls unrecoverable, produces that same reading with no `cd` for the hook to follow. Following `cd` makes the common case right; it cannot make the hook safe on its own.

## Decisions

### 1. Relative paths resolve against the payload's `cwd`

The session directory is taken from the payload's `cwd` when it is an absolute path, and from the hook's working directory otherwise. Today the two are equal, since Codex starts the hook in that directory, but the payload states it outright, the Vibe path already reads it the same way, and the directory tracking below needs an explicit anchor rather than an ambient one.

### 2. The patch is read as sections, and the targets are the files that survive it

`extractCodexMthdsFiles` collects every `Update File`, `Add File` and `Move to` header by one regular expression and leaves the existence check to find out which of them still exist. The new reader parses the envelope into sections instead, each a header with the lines under it, and computes the targets in order: an added or updated file becomes a target, a moved file stops being one and its destination becomes one, and a deleted file stops being one. The header lines recognised stay today's three, the same ones the `pipelex-plugins` wrapper pre-filters on, so the wrapper and the bundle keep agreeing about whether a patch touches a `.mthds` file.

This matters here because a shell patch's missing file is now a signal (Decision 6): the reader must not report as missing a file the patch itself moved away. It also gives Decision 5 the lines each section adds.

A `*** Begin Patch` or `*** End Patch` line starts a new envelope, so two sections share one only when no such line separates them. Counting the `End Patch` line matters for a patch passed as a quoted argument, `apply_patch '*** Begin Patch`, whose `Begin Patch` does not start a line: counting `Begin Patch` alone merged every such patch of a script into one envelope, where a delete in a branch that did not run hid another patch's edit.

### 3. For a `Bash` payload, the hook follows the shell's working directory through the script

The script is lexed as a POSIX shell script, the dialect both bash and zsh accept for everything read here, and walked in order with a directory that starts at the session directory. A patch header is placed at the directory of the patch command that reads it: the words of an `apply_patch` command, including a quoted argument spanning several lines, and the heredoc bodies it opened; and the text of a command feeding one, through a pipeline (`cat <<'EOF' | apply_patch`) or through a substitution in its words (`apply_patch "$(cat <<'EOF' …)"`), which is read in the patch command's directory whatever the feeding command does inside. Text that any other command holds is unread: a patch kept in a variable, written to a file for later, or run through `bash -c` or `eval` is read by a command this reading does not follow. The walk also handles one script applying several patches in different directories.

| Construct | How it is read |
| --- | --- |
| `cd DIR`, with one operand that is a literal word, optionally after `-L`, `-P` or `--` | The directory becomes `DIR`, resolved against the current one. An absolute `DIR` makes an unknown directory known again. |
| `cd` with no operand, `cd -`, an operand starting with `~`, an operand holding `$`, a backtick or a glob character, or several operands | The directory becomes unknown. |
| `pushd`, `popd`, `eval`, `source`, `.`, and any function definition | The directory becomes unknown. |
| `apply_patch` or `applypatch`, by name or by path, after assignments or `command` | The patch command: the headers it reads are placed at its directory. |
| `( … )`, `$( … )`, `<( … )` and `>( … )`, the last two also as a redirection's target | A scope: a `cd` inside it ends at the closing parenthesis. |
| A list sent to the background with `&`, and every member of a pipeline but the last | A subshell in bash and zsh alike, so a `cd` inside it ends with it. |
| A pipeline's last member | The directory becomes unknown when it moves, because zsh runs that member in the current shell and bash does not. |
| `{ … }` and the separators `&&`, `;` and newline | Followed in order, assuming each command succeeds, `cd` included. |
| `!` before a pipeline | Inverts its status, so a negated `cd` fails on the path the reading follows. |
| `\|\|`, the branches of `if` and `case`, and the passes of `for`, `select`, `while` and `until` loops | Where only one of several paths runs, the directory after is kept when every path leaves it the same, and is unknown otherwise. What runs only when a list that moved the shell failed (after `\|\|`, in `elif` and `else`, in an `until` loop's body, after a `while` loop) starts from an unknown directory; when it does not move the shell itself, such as `exit 1`, it leaves the directory to the path that succeeded. A loop whose passes start in different directories is read from an unknown one. |
| Heredoc bodies, quoted strings, comments, and the expression of a `[[ … ]]` | Never read as commands. A header in a comment belongs to no command and is dropped. |
| An unterminated quote, substitution, backtick or compound command, a heredoc inside backticks, an unbalanced `)`, or a closing word such as `fi` with nothing to close | The script is unparsed, and every relative path in it has an unknown directory. |

An `apply_patch` payload keeps today's reading: the patch tool's paths are relative to the session directory, so the tracking applies to `Bash` payloads alone. A payload with no `tool_name`, or any other one, is read as the patch tool's.

A real shell parser was considered and rejected. The ones available to JavaScript are either unmaintained or a WebAssembly build of a Go or tree-sitter grammar, which would add a second engine to a bundle already dominated by one, for a reading that needs only commands, quotes, heredocs and scopes. A hand-written lexer that knows its limits and says "unknown" past them is smaller and fails in the safe direction.

### 4. A relative path whose directory is unknown is not checked

When the directory at a header is unknown, or the script is unparsed, a relative path under that header is not resolved at all. The hook does not fall back to the session directory, because an unknown directory means the script moved somewhere the hook cannot follow, which is exactly when the session directory is the wrong guess. An absolute path is checked wherever the script ran when a patch command reads it, unless its file lacks the lines the patch added (Decision 5), since the reading follows branches and function bodies whether or not the script ran them; until the second round of the Checkpoint B review it was checked unconditionally, as today. One in text no patch command reads, or in an unparsed script, is confirmed first (Decision 5), since the script may only have stored the patch; until the Checkpoint B review it was checked, and formatted in place, unconfirmed.

### 5. Before checking a file a shell patch named, the hook confirms the file carries the patch's added lines

For a target that came from a `Bash` payload by a relative path, or by an absolute path that no patch command reads, the hook reads the file and checks that it contains the section's added lines in order, before any stage runs. The added lines are the section's `+` lines with the marker stripped and trailing whitespace trimmed, skipping blank ones; the file's lines are trimmed the same way. When several sections of one envelope name the same file, the last one's lines are used; when several envelopes of a script do, the file passes on any one's, since branches may have run only one of them. A section that adds no line, a bare rename or a pure deletion, confirms nothing, so its file is not checked and the note of Decision 6 names it. (Until the Checkpoint A review, such a section was accepted unconfirmed; the review showed it was the one way a misreading still reached a wrong file, see the plan's Decisions log.)

An absolute path that a patch command reads is held to a weaker test, since the path itself is certain and only whether the script reached the command is not: its file is checked unless every envelope that wrote it added lines the file lacks. A section that adds no line refutes nothing, so a pure deletion is still checked, while a patch in a branch the script did not take, or in a function it never called, no longer reformats a file it did not write. When such a file fails, it is dropped without a note, like any absolute path.

Only added lines count, because they are the only lines the patch program writes verbatim. They are compared as the patch program received them: in quotes the shell removes the quotes a line closes and reopens, as `'\''` does for an apostrophe in single quotes, and in double quotes or an unquoted heredoc it removes backslash escapes too, so the hook does the same; a line holding a `$` or backtick expansion, whose value the hook cannot know, is left out, and when a line ends in other quoting than it began in, or in a backslash joining it to the next, no line of its section is compared, since the lines after it are read in quoting the hook does not follow. Context lines are matched loosely by Codex's applier, exactly, then ignoring trailing whitespace, then ignoring whitespace at both ends (`apply-patch/src/seek_sequence.rs`), so a context line in the patch may not appear verbatim in the file, and comparing them would reject the right file.

This check is what makes the hook safe against the `workdir` route and against any misreading of the script: a file in the wrong directory almost never holds the lines the patch just added, so it is skipped rather than checked and rewritten. It is a necessary condition, not proof. A near-copy of the edited file that already holds every added line would still pass, and the known limits below say so. It runs for `Bash` payloads only, since the patch tool's paths are anchored reliably and its reading should not change.

### 6. When a shell patch's `.mthds` file goes unchecked, the hook tells the agent

A relative `.mthds` path from a `Bash` payload that ends up unchecked, because its directory is unknown, because no file exists where it resolves and the patch did not remove it, or because the file there fails the content check, is listed in one non-blocking note, sent as additional context:

> The .mthds hook did not check `broken.mthds`: it could not confirm which file this shell command patched. Name the file by its absolute path, or edit it with the apply_patch tool, and the hook will check it.

An absolute path that fails the content check is dropped without a note, since its file does not hold the lines of a patch the script only stored or never reached.

The hook's fail-open stages pass silently, and this note keeps that posture: it never blocks. It needs none of them, so it is sent even when the engine cannot load. It speaks up where they stay silent because the cause is different. A missing key or an unreachable API is nothing the agent can change, while a relative path in a shell patch is, and without the note the agent reads silence as a clean check. The note follows the existing merge rule, so a block from another file in the same patch wins and the note is dropped from that response. It is never sent for the patch tool, where a missing file means the patch moved or deleted it.

### 7. Where the code lives

- `src/hooks/patch-envelope.ts`: the section reader and the targets computation (Decision 2), pure.
- `src/hooks/shell-script.ts`: the lexer and the directory walk (Decision 3), pure. It answers, for an offset in the script, a directory, `unknown`, `unread` when no patch command reads that offset, or `outside` when no command holds it, and how the shell quotes the offset.
- `src/hooks/check-core.ts`: `extractCodexMthdsTargets` replaces `extractCodexMthdsFiles`. It takes the stdin payload and the hook's working directory, and returns whether the payload came from the shell, the targets as absolute paths with the lines each section added, and the relative paths it could not place. The content check and the note's text are pure functions beside it.
- `src/hooks/claude-mthds-check.ts`: `resolveTargets` and `checkOneFile` gain the content check and collect the unchecked paths, and `main` merges the note into the outcomes. The content check reads the file when the targets are selected, and `checkOneFile` reads it again when its turn comes, with no await between that read and the format write-back, so a file edited or deleted while an earlier one was being validated is never overwritten with older content. (Reading it once, for both, lost such an edit and recreated such a deleted file; the second round of the Checkpoint B review caught it.)

`extractCodexMthdsFiles` is not exported from the package's public entry, so the rename breaks no consumer.

### 8. What does not change

The Claude and Vibe readings, the patch tool's reading apart from the anchor of Decision 1, the lint, format and validate stages, the output dialects, the merge rule and the exit code are unchanged. The `pipelex-plugins` wrapper and its pre-filter need no change: the bundle still receives every payload the pre-filter lets through.

## Known limits

- **A near-copy can still be checked.** A same-named file in the session directory that already holds every added line of the patch passes the content check. This needs a copy of the method in two places and a patch run elsewhere by `workdir`, and even then the file checked is a copy of the one edited.
- **Another hook may run first.** A user's own `PostToolUse` hook that reformats `.mthds` files on `Bash` before this one would make the added lines differ from the file, and the hook would skip the file, with the note for a relative path and without one for an absolute path. `mthds-agent`'s Codex hook matches the patch tool only, so it cannot be that hook.
- **An unreached patch that only removes lines is checked.** An absolute path in such a patch, in a branch the script did not take or a function it never called, is checked, since nothing it added can show it did not run. Asking for proof of execution instead would turn every pure deletion through the shell into an unchecked file with no note, which the ratified note scope does not allow; the third round of the Checkpoint B review kept it.
- **A delete in another branch can hide the note.** `removedByPatch` is set when any envelope deletes or moves the file, so when one branch writes a relative path and another deletes it, and no file exists where the path resolved (a `workdir` the payload does not show), the note is not sent. Deferred by the third round of the Checkpoint B review, unverified.
- **A header path holding an expansion is not read.** `*** Update File: $FILE` in an unquoted heredoc does not end in `.mthds` as written, so the file is neither checked nor named, as on `dev`. Deferred by the third round of the Checkpoint B review, unverified.
- **Every member of a pipeline is read as feeding its patch command.** In `apply_patch <<REAL | cat <<OTHER`, the text of `OTHER` is placed as if the patch command read it, although a pipeline's data flows only to the right. Deferred by the third round of the Checkpoint B review, unverified.
- **`CDPATH`, login profiles and failing commands are ignored.** A `cd` is assumed to succeed and to go where its operand says, and so is a command before `&&`, so `[[ -d build ]] && cd build` is read as moving into `build`. The content check catches the cases where it did not. Reading such a guard as either path would make the directory unknown whenever the guard is followed by a `cd`, trading a check in the common case for a note, so the Checkpoint B review kept it.
- **A patch read later is not followed.** A patch kept in a variable, written to a file, run through `bash -c`, `eval` or a function, or fed to a patch command inside a subshell or a group, is unread, so its relative paths get the note rather than a check, and its absolute paths are checked only when their files carry the patch's added lines.
- **Heredocs opened with `<<-` and indented patch lines.** The shell strips leading tabs from such a body, and the header expression, anchored at the start of a line, does not see a tab-indented header, today as after this change.
- **Only POSIX shells are read.** A PowerShell script on Windows is read as a POSIX one; the content check keeps a misreading from checking the wrong file.
- **A patch Codex applies in process is still invisible.** `apply_patch <<'EOF' … EOF` alone, or after exactly `cd <dir> &&`, fires no `PostToolUse` at all (recorded in `pipelex-plugins` `docs/hooks.md`); nothing in the bundle can change that.

## Downstream

The bundle reaches users only when `pipelex-plugins` re-vendors it with `make vendor-hook` from a checkout of this repository's `dev`, which its `make check-hook-fresh` release gate requires. No `@pipelex/sdk` release is needed, since the tarball does not ship the bundle. `pipelex-plugins` then flips `test_a_relative_path_in_a_codex_patch_is_read_from_the_session_directory` in `tests/unit/test_hook_commands.py` to expect the block on `sub/broken.mthds`, adds the wrong-file case above as a test that the session directory's file is left byte for byte unchanged and the note is sent, and rewrites the paragraph "A relative path in a patch is read from the session's directory" in `docs/hooks.md`. That is a `pipelex-plugins` item, blocked by this one.

## Open questions

Answered by Louis on 2026-09-25, each with the recommended answer: Decisions 5 and 6 stay in this item, the item is retyped to `bug` at severity `normal`, and the note keeps the wording of Decision 6 and covers relative paths only. The questions are kept below as they were asked.

1. **Keep Decisions 5 and 6 in this item?** Recommended: yes. They close the rewrite of an untouched file, which following `cd` alone does not, and they are the only answer to the `workdir` route. The alternative is to ship Decisions 1 to 4 here and file the content check and the note as a second item, which leaves a known file-rewriting path open in between.
2. **Retype the item from `feature` to `bug`?** Recommended: yes, since the hook rewrites a file the agent did not edit. The severity can stay `normal`, because the rewrite is a format pass that keeps the method's meaning, and it needs a same-named file in the session directory.
3. **The note's wording** in Decision 6, and whether it should also fire for an absolute path whose file does not exist. Recommended: relative paths only, since an absolute path is checked wherever the patch ran, and a missing one was moved or removed by the script.

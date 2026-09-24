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

### 3. For a `Bash` payload, the hook follows the shell's working directory through the script

The script is lexed as a POSIX shell script, the dialect both bash and zsh accept for everything read here, and walked in order with a directory that starts at the session directory. Each patch header belongs to the command whose text holds it: the command's own words, including a quoted argument spanning several lines, or a heredoc body that command opened. The header's directory is the directory in effect when that command runs. This one rule covers every form a patch is fed in: `apply_patch <<'EOF'`, `apply_patch '…'`, `cat <<'EOF' | apply_patch`, and `apply_patch "$(cat <<'EOF' …)"`, where the heredoc belongs to a command inside a substitution that runs in the same directory. It also handles one script applying several patches in different directories.

| Construct | How it is read |
| --- | --- |
| `cd DIR`, with one operand that is a literal word, optionally after `-L`, `-P` or `--` | The directory becomes `DIR`, resolved against the current one. An absolute `DIR` makes an unknown directory known again. |
| `cd` with no operand, `cd -`, an operand starting with `~`, an operand holding `$`, a backtick or a glob character, or several operands | The directory becomes unknown. |
| `pushd`, `popd`, `eval`, `source`, `.`, and any function definition | The directory becomes unknown. |
| A `cd` in a pipeline, or in a command sent to the background with `&` | The directory becomes unknown, because bash runs it in a subshell while zsh runs a pipeline's last command in the current shell. |
| `( … )` and `$( … )` | A scope: a `cd` inside it ends at the closing parenthesis. |
| `{ … }`, the bodies of `if`, `while`, `until`, `for` and `case`, and the separators `&&`, `\|\|`, `;` and newline | Followed in order, as if every command ran. A `cd` in a branch that was not taken is caught by the content check (Decision 5). |
| Heredoc bodies, quoted strings and comments | Never read as commands. A header in a comment belongs to no command and is dropped. |
| An unterminated quote, substitution or backtick, a heredoc inside backticks, or an unbalanced `)` | The script is unparsed, and every relative path in it has an unknown directory. |

An `apply_patch` payload keeps today's reading: the patch tool's paths are relative to the session directory, so the tracking applies to `Bash` payloads alone. A payload with no `tool_name`, or any other one, is read as the patch tool's.

A real shell parser was considered and rejected. The ones available to JavaScript are either unmaintained or a WebAssembly build of a Go or tree-sitter grammar, which would add a second engine to a bundle already dominated by one, for a reading that needs only commands, quotes, heredocs and scopes. A hand-written lexer that knows its limits and says "unknown" past them is smaller and fails in the safe direction.

### 4. A relative path whose directory is unknown is not checked

When the directory at a header is unknown, or the script is unparsed, a relative path under that header is not resolved at all. The hook does not fall back to the session directory, because an unknown directory means the script moved somewhere the hook cannot follow, which is exactly when the session directory is the wrong guess. An absolute path is checked wherever the script ran, as today.

### 5. Before checking a file a shell patch named, the hook confirms the file carries the patch's added lines

For a target that came from a `Bash` payload, the hook reads the file and checks that it contains the section's added lines in order, before any stage runs. The added lines are the section's `+` lines with the marker stripped and trailing whitespace trimmed, skipping blank ones; the file's lines are trimmed the same way. When several sections name the same file, the last one's lines are used. A section that adds no line, a bare rename or a pure deletion, confirms nothing and is accepted.

Only added lines count, because they are the only lines Codex writes verbatim. Context lines are matched loosely by Codex's applier, exactly, then ignoring trailing whitespace, then ignoring whitespace at both ends (`apply-patch/src/seek_sequence.rs`), so a context line in the patch may not appear verbatim in the file, and comparing them would reject the right file.

This check is what makes the hook safe against the `workdir` route and against any misreading of the script: a file in the wrong directory almost never holds the lines the patch just added, so it is skipped rather than checked and rewritten. It is a necessary condition, not proof. A near-copy of the edited file that already holds every added line would still pass, and the known limits below say so. It runs for `Bash` payloads only, since the patch tool's paths are anchored reliably and its reading should not change.

### 6. When a shell patch's `.mthds` file goes unchecked, the hook tells the agent

A relative `.mthds` path from a `Bash` payload that ends up unchecked, because its directory is unknown, because no file exists where it resolves, or because the file there fails the content check, is listed in one non-blocking note, sent as additional context:

> The .mthds hook did not check `broken.mthds`: it could not confirm which file this shell command patched. Name the file by its absolute path, or edit it with the apply_patch tool, and the hook will check it.

The hook's fail-open stages pass silently, and this note keeps that posture: it never blocks. It speaks up where they stay silent because the cause is different. A missing key or an unreachable API is nothing the agent can change, while a relative path in a shell patch is, and without the note the agent reads silence as a clean check. The note follows the existing merge rule, so a block from another file in the same patch wins and the note is dropped from that response. It is never sent for the patch tool, where a missing file means the patch moved or deleted it.

### 7. Where the code lives

- `src/hooks/patch-envelope.ts`: the section reader and the targets computation (Decision 2), pure.
- `src/hooks/shell-script.ts`: the lexer and the directory walk (Decision 3), pure. It answers, for an offset in the script, a directory, `unknown`, or `outside` when no command holds that offset.
- `src/hooks/check-core.ts`: `extractCodexMthdsTargets` replaces `extractCodexMthdsFiles`. It takes the stdin payload and the hook's working directory, and returns whether the payload came from the shell, the targets as absolute paths with the lines each section added, and the relative paths it could not place. The content check and the note's text are pure functions beside it.
- `src/hooks/claude-mthds-check.ts`: `resolveTargets` and `checkOneFile` gain the content check and collect the unchecked paths, and `main` merges the note into the outcomes. The file is read once, for both the check and the lint stage.

`extractCodexMthdsFiles` is not exported from the package's public entry, so the rename breaks no consumer.

### 8. What does not change

The Claude and Vibe readings, the patch tool's reading apart from the anchor of Decision 1, the lint, format and validate stages, the output dialects, the merge rule and the exit code are unchanged. The `pipelex-plugins` wrapper and its pre-filter need no change: the bundle still receives every payload the pre-filter lets through.

## Known limits

- **A near-copy can still be checked.** A same-named file in the session directory that already holds every added line of the patch passes the content check. This needs a copy of the method in two places and a patch run elsewhere by `workdir`, and even then the file checked is a copy of the one edited.
- **Another hook may run first.** A user's own `PostToolUse` hook that reformats `.mthds` files on `Bash` before this one would make the added lines differ from the file, and the hook would skip the file with the note. `mthds-agent`'s Codex hook matches the patch tool only, so it cannot be that hook.
- **`CDPATH`, login profiles and failing commands are ignored.** A `cd` is assumed to succeed and to go where its operand says. The content check catches the cases where it did not.
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

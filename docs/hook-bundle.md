# The `.mthds` hook bundle

`dist-hooks/check.mjs` is the post-edit hook that checks a `.mthds` file after a coding agent edits it. It is built from `src/hooks/` by `npm run build:hook` and vendored by `pipelex-plugins`, which runs it after edits in Claude Code, Codex and Mistral Vibe (see [`architecture.md`](./architecture.md#hook-bundle-distcheckmjs) for how it is built and distributed). This page covers which file the hook checks on each platform, and in particular how it finds the file a Codex patch wrote.

## What the hook does with a file

Each file goes through three stages: a local lint that blocks on any diagnostic, a local format that rewrites the file in place when its layout changes, and a validation by the hosted API (`POST /v1/validate`) that blocks on an invalid verdict and adds a non-blocking note about pending pipe signatures. The hook fails open: when the engine cannot load, when `PIPELEX_API_KEY` is unset or the API cannot be reached, the stage that could not run passes silently and the others stand. When several files are checked, one block among them wins and the notes are joined, and each file is read when its turn comes, so an edit made to it while an earlier file was being validated is checked rather than overwritten. The hook always exits 0, since its verdict is on stdout.

## Which file it checks

| Platform | Where the edited file comes from |
| --- | --- |
| Claude Code | `tool_input.file_path` of the `PostToolUse` payload. |
| Mistral Vibe | The `post_tool` payload's `tool_output.file`, `tool_output.path`, `tool_input.file_path` or `tool_input.path`, resolved against the payload's `cwd`, when `tool_status` is `success`. |
| Codex | The patch in `tool_input.command`, which may name several files, read as described below. |

A file that no longer exists is not checked.

## Codex: the patch

Codex edits files with patches in its own envelope: `*** Begin Patch`, one section per file, `*** End Patch`. A section opens with `*** Add File: <path>`, `*** Update File: <path>` (optionally followed by `*** Move to: <path>`) or `*** Delete File: <path>`, and its `+` lines are the lines it adds, which the patch program writes verbatim.

The hook reads the envelope as sections and applies them in order to find the `.mthds` files the patch leaves on disk: an added or updated file is one, a moved file is replaced by its destination, and a deleted file is dropped. A relative path resolves against the session directory, which is the payload's `cwd` when it is absolute, and the hook's own working directory otherwise (Codex starts the hook in that same directory).

A patch made with Codex's `apply_patch` tool arrives with `tool_name: "apply_patch"`, and its paths are relative to the session directory by construction. Every file it leaves on disk is checked.

## Codex: a patch run through the shell

A Codex model can also run the patch program from a shell script, for instance `cd sub; apply_patch <<'EOF' … EOF`. Codex reports that as `tool_name: "Bash"`, with the whole script in `tool_input.command`, and the patch's relative paths are then relative to wherever the script had moved when `apply_patch` ran. The payload carries nothing else: the directory Codex's `exec_command` may have been given as `workdir` is not in it.

So for a `Bash` payload, the hook reads the script as a POSIX shell script (the dialect bash and zsh share for everything read here), follows its working directory from the session directory, and places each patch section at the directory of the `apply_patch` command that reads it.

### What reads the patch

A section is placed only where a patch command reads it: the words of an `apply_patch` command (including a quoted argument spanning several lines) and the heredocs it opens, and the text of a command feeding one through a pipeline (`cat <<'EOF' | apply_patch`) or through a substitution in its words (`apply_patch "$(cat <<'EOF' … EOF\n)"`). A patch fed by a substitution is placed at the patch command's directory, whatever the substitution does inside. `apply_patch` is recognised by name or by path, and after assignments or `command`; `applypatch` is the same program.

A section held by any other command is not placed. That includes a patch kept in a variable, written to a file for later, run through `bash -c`, `eval` or a function, or fed to a patch command that sits inside a subshell or a group, because what reads it later is not something the reading follows. Its relative paths are unplaced, and its absolute paths go through the content check below, since the script may never have applied the patch.

### How the directory is followed

| Construct | How it is read |
| --- | --- |
| `cd DIR`, with one operand that is a literal word, optionally after `-L`, `-P` or `--` | The directory becomes `DIR`, resolved against the current one, assuming the `cd` succeeds. An absolute `DIR` makes an unknown directory known again. |
| `cd` with no operand, `cd -`, an operand starting with `~`, an operand holding `$`, a backtick or a glob character, several operands, or an unknown option | The directory becomes unknown. |
| `pushd`, `popd`, `eval`, `source`, `.`, and any function definition | The directory becomes unknown. |
| `( … )`, `$( … )`, `<( … )` and `>( … )`, the last two also as a redirection's target (`done < <(find …)`) | A scope: a `cd` inside it ends at the closing parenthesis. |
| A list sent to the background with `&`, and every member of a pipeline but the last | A subshell in bash and zsh alike, so a `cd` inside it ends with it. |
| A pipeline's last member | The directory becomes unknown when it moves, because zsh runs that member in the current shell and bash does not. |
| `{ … }` and the separators `&&`, `;` and newline | Followed in order, assuming each command succeeds. |
| `!` before a pipeline | Inverts its status, so a negated `cd` fails on the path the reading follows. |
| `\|\|`, the branches of `if` and `case`, and the passes of `for`, `select`, `while` and `until` loops | Where only one of several paths runs, the directory after is kept when every path leaves it the same, and becomes unknown otherwise. What runs only when a list that moved the shell failed, after `\|\|`, in `elif` and `else`, in an `until` loop's body or after a `while` loop, starts from an unknown directory, since the list may have failed anywhere; when it does not move the shell itself, such as `exit 1`, it leaves the directory to the path that succeeded. A loop whose passes start in different directories is read from an unknown one. |
| Heredoc bodies, quoted strings, comments, and the expression of a `[[ … ]]` | Never read as commands. |
| An unterminated quote, substitution, backtick or compound command, a heredoc inside backticks, an unbalanced `)`, or a closing word such as `fi` with nothing to close | The script is unparsed, and every relative path in it is unplaced. |

A relative path under an unknown directory, or anywhere in an unparsed script, is not resolved at all: the hook does not fall back to the session directory, because an unknown directory means the script moved somewhere the hook cannot follow, which is exactly when the session directory is the wrong guess. An absolute path resolves wherever the script ran. When one script applies several patches, in heredocs or as quoted arguments, each is read on its own, so a patch deleting a file in one directory never hides another patch's edit of a same-named file, and a file any of them leaves on disk is a target.

### The content check

The reading can be wrong, and a script run with `exec_command`'s `workdir` looks like one run in the session directory. So before checking a file that a `Bash` patch named by a relative path, or by an absolute path in text no patch command reads, the hook confirms the file carries the lines the patch added, in order. Each line is compared with its trailing whitespace trimmed, and blank lines are skipped. Only added lines count, because they are the only lines the patch program writes verbatim: it matches a patch's context lines loosely, so comparing them would reject the right file. When several patches in the script wrote the file, the lines of any one of them confirm it.

The lines are compared as the patch program received them. In a quoted heredoc (`<<'EOF'`) or single quotes, that is the script's text. In double quotes or an unquoted heredoc, the shell removes backslash escapes first, so `\"` in a double-quoted patch is compared as `"`, and a line holding a `$` or backtick expansion is left out of the comparison, since the hook cannot know what it expanded to.

A file in another directory than the one the patch wrote almost never holds the lines the patch just added, so it is skipped rather than checked and reformatted. A section that adds no line, a pure deletion or a bare rename, gives the hook nothing to compare, so its file is not checked either.

An absolute path that a patch command reads names its file for certain, but the reading does not know whether the script reached that command: it reads a branch that did not run, or a function nobody called, like any other. So the hook checks such a file unless it lacks the lines the patch added, which shows the script did not write it. A section that adds no line shows nothing, so its file is checked.

### The note

When a relative `.mthds` path from a `Bash` patch goes unchecked, because it is unplaced, because the file there does not carry the patch's added lines, or because no file exists where it resolves (unless the patch itself deleted or moved it), the hook names it in one non-blocking note, sent as additional context:

> The .mthds hook did not check `broken.mthds`: it could not confirm which file this shell command patched. Name the file by its absolute path, or edit it with the apply_patch tool, and the hook will check it.

An absolute path that fails the content check is dropped without a note: its file does not hold the lines of a patch the script only stored or never reached, so the script did not write it.

The note never blocks, and a block from another file in the same call wins over it. It is sent even when the engine that runs the checks cannot load. It exists because a missing file or an unknown directory is something the agent can fix, unlike a missing API key, and without it the agent would read the hook's silence as a clean check. It is never sent for the `apply_patch` tool, whose paths are anchored reliably.

### Known limits

- **A near-copy can still be checked.** A same-named file elsewhere that already holds every line the patch added passes the content check. It takes a copy of the method in two places and a patch run in the other one.
- **Another hook may run first.** A user's own `PostToolUse` hook that reformats `.mthds` files on `Bash` before this one would make the added lines differ from the file, and the hook would skip the file with the note.
- **`CDPATH`, login profiles and failing commands are ignored.** A `cd` is assumed to succeed and to go where its operand says, and so is a command before `&&`, so `[[ -d build ]] && cd build` is read as moving into `build`. The content check catches the cases where it did not.
- **A heredoc opened with `<<-` and indented patch lines.** The shell strips leading tabs from such a body, but a patch header is read only at the start of a line, so a tab-indented header is not seen.
- **Only POSIX shells are read.** A PowerShell script is read as a POSIX one; the content check keeps a misreading from checking the wrong file.
- **A patch Codex applies itself fires no hook.** Codex intercepts a script that is exactly `apply_patch <<'EOF' … EOF`, alone or after one `cd <dir> &&`, and applies the patch in process without any `PostToolUse` event, so nothing in the bundle sees it.

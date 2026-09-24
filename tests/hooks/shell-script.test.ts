/**
 * The shell reading behind a Codex `Bash` patch: for each patch header in a
 * script, the directory the command holding it runs in. One row per construct
 * of the design's table (wip/follow-cd-before-resolving/design.md, Decision 3).
 */

import { describe, expect, it } from "vitest";
import { readShellScript } from "../../src/hooks/shell-script.js";

const SESSION = "/s";
const PATCH = "*** Begin Patch\n*** Update File: a.mthds\n@@\n+x\n*** End Patch";
/** A heredoc-fed patch, as Codex models usually write one. */
const APPLY = `apply_patch <<'EOF'\n${PATCH}\nEOF`;

/** The placement of every patch header in the script, in order. */
function placements(script: string): string[] | "unparsed" {
  const reading = readShellScript(script, SESSION);
  if (reading === "unparsed") {
    return "unparsed";
  }
  const found: string[] = [];
  const header = /^\*\*\* Update File:/gm;
  let match: RegExpExecArray | null;
  while ((match = header.exec(script)) !== null) {
    const placement = reading.directoryAt(match.index);
    found.push(placement.kind === "directory" ? placement.path : placement.kind);
  }
  return found;
}

describe("readShellScript: following cd", () => {
  it.each([
    ["no cd", `${APPLY}\n`, ["/s"]],
    ["cd then ;", `cd sub; ${APPLY}\n`, ["/s/sub"]],
    ["cd then &&", `cd sub && ${APPLY}\n`, ["/s/sub"]],
    ["cd then a newline", `cd sub\n${APPLY}\n`, ["/s/sub"]],
    ["cd then ||", `cd sub || true\n${APPLY}\n`, ["/s/sub"]],
    ["an absolute cd", `cd /abs/dir && ${APPLY}`, ["/abs/dir"]],
    ["two cds in a row", `cd a && cd b && ${APPLY}`, ["/s/a/b"]],
    ["cd ..", `cd a/b && cd .. && ${APPLY}`, ["/s/a"]],
    ["a quoted operand holding a space", `cd "my dir" && ${APPLY}`, ["/s/my dir"]],
    ["a single-quoted operand", `cd 'sub' && ${APPLY}`, ["/s/sub"]],
    ["an escaped space", `cd my\\ dir && ${APPLY}`, ["/s/my dir"]],
    ["cd -L", `cd -L sub && ${APPLY}`, ["/s/sub"]],
    ["cd -P", `cd -P sub && ${APPLY}`, ["/s/sub"]],
    ["cd --", `cd -- -sub && ${APPLY}`, ["/s/-sub"]],
    ["a redirection after the operand", `cd sub 2>/dev/null && ${APPLY}`, ["/s/sub"]],
    ["a redirection before the command", `>/dev/null cd sub && ${APPLY}`, ["/s/sub"]],
    ["an assignment before cd", `CDPATH= cd sub && ${APPLY}`, ["/s/sub"]],
    ["builtin cd", `builtin cd sub && ${APPLY}`, ["/s/sub"]],
    ["command cd", `command cd sub && ${APPLY}`, ["/s/sub"]],
    ["a quoted command name", `"cd" sub && ${APPLY}`, ["/s/sub"]],
    ["a line continuation", `cd \\\nsub && ${APPLY}`, ["/s/sub"]],
    ["a cd in if's body", `if true; then cd sub; fi\n${APPLY}`, ["/s/sub"]],
    ["a cd in a loop body", `for d in a; do cd sub; done\n${APPLY}`, ["/s/sub"]],
    ["a cd in a group", `{ cd sub; }\n${APPLY}`, ["/s/sub"]],
    ["a cd in a case branch", `case x in x) cd sub;; esac\n${APPLY}`, ["/s/sub"]],
    [
      "a cd in an arithmetic for",
      `for ((i = 0; i < 1; i++)); do cd sub; done\n${APPLY}`,
      ["/s/sub"],
    ],
    ["cd in a comment", `# cd other\n${APPLY}`, ["/s"]],
    ["a trailing comment", `cd sub # then patch\n${APPLY}`, ["/s/sub"]],
  ])("%s", (_name, script, expected) => {
    expect(placements(script)).toEqual(expected);
  });
});

describe("readShellScript: an unknown directory", () => {
  it.each([
    ["an operand holding $", `cd "$X" && ${APPLY}`],
    ["an operand holding a substitution", `cd "$(dirname x)" && ${APPLY}`],
    ["an operand holding a backtick", "cd `dirname x` && " + APPLY],
    ["cd alone", `cd && ${APPLY}`],
    ["cd -", `cd - && ${APPLY}`],
    ["an operand starting with ~", `cd ~/x && ${APPLY}`],
    ["an operand holding a glob", `cd su* && ${APPLY}`],
    ["an operand holding a brace", `cd {a,b} && ${APPLY}`],
    ["an empty operand", `cd '' && ${APPLY}`],
    ["several operands", `cd a b && ${APPLY}`],
    ["an unknown option", `cd -e sub && ${APPLY}`],
    ["zsh's directory stack", `cd +1 && ${APPLY}`],
    ["a relative cd from an unknown directory", `cd "$X" && cd sub && ${APPLY}`],
    ["pushd", `pushd sub && ${APPLY}`],
    ["popd", `popd && ${APPLY}`],
    ["eval", `eval "cd sub" && ${APPLY}`],
    ["source", `source env.sh && ${APPLY}`],
    [". (dot)", `. ./env.sh && ${APPLY}`],
    ["a function definition", `f() { cd sub; }\n${APPLY}`],
    ["a function keyword definition", `function f { cd sub; }\n${APPLY}`],
    ["a cd in a pipeline", `cd sub | cat\n${APPLY}`],
    ["a cd sent to the background", `cd sub &\n${APPLY}`],
    ["a group with a cd in a pipeline", `{ cd sub; } | cat\n${APPLY}`],
  ])("%s", (_name, script) => {
    expect(placements(script)).toEqual(["unknown"]);
  });

  it("makes an unknown directory known again with an absolute cd", () => {
    expect(placements(`cd "$X" && cd /abs && ${APPLY}`)).toEqual(["/abs"]);
  });

  it("places a patch in a function's body as unknown", () => {
    expect(placements(`f() {\n${APPLY}\n}\nf`)).toEqual(["unknown"]);
  });
});

describe("readShellScript: scopes", () => {
  it("ends a subshell's cd at its closing parenthesis", () => {
    expect(placements(`(cd sub && ${APPLY}\n); ${APPLY}\n`)).toEqual(["/s/sub", "/s"]);
  });

  it("ends a command substitution's cd at its closing parenthesis", () => {
    expect(placements(`x=$(cd sub; pwd)\n${APPLY}`)).toEqual(["/s"]);
  });

  it("leaves the directory unchanged by a pipeline or background list that does not move", () => {
    expect(placements(`ls | cat\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
    expect(placements(`sleep 1 &\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("follows a cd inside a background list for the commands of that list", () => {
    const script = `cd sub && apply_patch <<'EOF' &\n${PATCH}\nEOF\n${APPLY}\n`;
    expect(placements(script)).toEqual(["/s/sub", "unknown"]);
  });

  it("starts every member of a pipeline in the pipeline's directory", () => {
    expect(placements(`cd sub; cat <<'EOF' | apply_patch\n${PATCH}\nEOF\n`)).toEqual(["/s/sub"]);
  });

  it("follows a cd inside a subshell for the rest of that subshell", () => {
    expect(placements(`(cd sub; cd deeper; ${APPLY}\n)`)).toEqual(["/s/sub/deeper"]);
  });
});

describe("readShellScript: how a patch is fed", () => {
  it("places a heredoc body at the command that opened it", () => {
    expect(placements(`cd sub && ${APPLY}\n`)).toEqual(["/s/sub"]);
  });

  it("does not follow a cd line inside a heredoc body", () => {
    expect(placements(`cat <<'X'\ncd other\nX\n${APPLY}\n`)).toEqual(["/s"]);
  });

  it("places a patch in a single-quoted argument", () => {
    expect(placements(`cd sub && apply_patch '${PATCH}'\n`)).toEqual(["/s/sub"]);
  });

  it("places a patch in a double-quoted argument", () => {
    expect(placements(`cd sub && apply_patch "${PATCH}"\n`)).toEqual(["/s/sub"]);
  });

  it("places a patch fed through a substitution after a cd", () => {
    const script = `cd sub && apply_patch "$(cat <<'EOF'\n${PATCH}\nEOF\n)"\n`;
    expect(placements(script)).toEqual(["/s/sub"]);
  });

  it("places two patches with a cd between them", () => {
    expect(placements(`${APPLY}\ncd sub\n${APPLY}\n`)).toEqual(["/s", "/s/sub"]);
  });

  it("reads several heredocs opened on one line in order", () => {
    const script = `cat <<'A' <<'B'\ncd other\nA\ncd more\nB\ncd sub && ${APPLY}\n`;
    expect(placements(script)).toEqual(["/s/sub"]);
  });

  it("strips leading tabs from a <<- body's delimiter line", () => {
    const script = `cd sub && apply_patch <<-EOF\n${PATCH}\n\tEOF\ncd deeper\n${APPLY}\n`;
    expect(placements(script)).toEqual(["/s/sub", "/s/sub/deeper"]);
  });

  it("reads a heredoc whose delimiter is the last line, with no newline after it", () => {
    expect(placements(`cd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("reads an unterminated heredoc to the end of the script", () => {
    expect(placements(`cd sub && apply_patch <<'EOF'\n${PATCH}\n`)).toEqual(["/s/sub"]);
  });

  it("reads a heredoc opened before && and continued on the next line", () => {
    const script = `cd sub && apply_patch <<'EOF' &&\n${PATCH}\nEOF\necho applied\n`;
    expect(placements(script)).toEqual(["/s/sub"]);
  });

  it("does not open a heredoc for a here-string", () => {
    expect(placements(`cat <<< "cd other"\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("places a patch under a quoted heredoc delimiter holding quotes", () => {
    const script = `cd sub && apply_patch <<"P"ATCH\n${PATCH}\nPATCH\n`;
    expect(placements(script)).toEqual(["/s/sub"]);
  });
});

describe("readShellScript: lexing", () => {
  it("reads $'…', ${…}, $((…)) and array values without losing its place", () => {
    const script =
      `x=$'a\\'b'; y=\${HOME:-"$(pwd)"}; z=$((1 << 2)); arr=(a "b c")\n` + `cd sub && ${APPLY}`;
    expect(placements(script)).toEqual(["/s/sub"]);
  });

  it("reads a process substitution as a scope", () => {
    expect(placements(`diff <(cd other; ls) b\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("reads an arithmetic command", () => {
    expect(placements(`(( x = 1 << 2 ))\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("answers outside for an offset in a comment or between commands", () => {
    const script = `# a comment\n\ncd sub\n`;
    const reading = readShellScript(script, SESSION);
    expect(reading).not.toBe("unparsed");
    if (reading === "unparsed") return;
    expect(reading.directoryAt(script.indexOf("comment"))).toEqual({ kind: "outside" });
    expect(reading.directoryAt(script.indexOf("\n\n") + 1)).toEqual({ kind: "outside" });
    expect(reading.directoryAt(script.indexOf("sub"))).toEqual({ kind: "directory", path: "/s" });
  });
});

describe("readShellScript: unparsed", () => {
  it.each([
    ["an unterminated single quote", `cd 'sub && ${APPLY}`],
    ["an unterminated double quote", `cd "sub && ${APPLY}`],
    ["an unterminated substitution", `x=$(cd sub\n${APPLY}`],
    ["an unterminated backtick", "x=`cd sub\n" + APPLY],
    ["an unterminated parameter expansion", `x=\${HOME\n${APPLY}`],
    ["an unbalanced )", `cd sub)\n${APPLY}`],
    ["an unterminated subshell", `(cd sub\n${APPLY}`],
    ["a heredoc inside backticks", "x=`cat <<EOF\ncd sub\nEOF`\n" + APPLY],
    ["a redirection with no target", `cd sub >\n${APPLY}`],
  ])("%s", (_name, script) => {
    expect(placements(script)).toBe("unparsed");
  });
});

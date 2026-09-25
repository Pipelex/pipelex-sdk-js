/**
 * The shell reading behind a Codex `Bash` patch: for each patch header in a
 * script, the directory the command holding it runs in. One row per construct
 * of the design's table (wip/follow-cd-before-resolving/design.md, Decision 3).
 */

import { describe, expect, it } from "vitest";
import { linesAsRead, readShellScript } from "../../src/hooks/shell-script.js";

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
    ["a cd in a group", `{ cd sub; }\n${APPLY}`, ["/s/sub"]],
    ["a negated cd", `! cd sub\n${APPLY}`, ["/s/sub"]],
    ["a timed cd", `time -p cd sub\n${APPLY}`, ["/s/sub"]],
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
    ["a directory longer than any PATH_MAX", `cd ${"a/".repeat(2100)} && ${APPLY}`],
    ["pushd", `pushd sub && ${APPLY}`],
    ["popd", `popd && ${APPLY}`],
    ["eval", `eval "cd sub" && ${APPLY}`],
    ["source", `source env.sh && ${APPLY}`],
    [". (dot)", `. ./env.sh && ${APPLY}`],
    ["a function definition", `f() { cd sub; }\n${APPLY}`],
    ["a function keyword definition", `function f { cd sub; }\n${APPLY}`],
    ["a cd as a pipeline's last member", `echo | cd sub\n${APPLY}`],
    ["a loop moving as a pipeline's last member", `ls | while read d; do cd sub; done\n${APPLY}`],
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

  it.each([
    ["a cd in a pipeline", `cd sub | cat\n${APPLY}`],
    ["a group with a cd in a pipeline", `{ cd sub; } | cat\n${APPLY}`],
    ["a loop in a pipeline", `for d in x; do cd sub; done | cat\n${APPLY}`],
    ["a cd sent to the background", `cd sub &\n${APPLY}`],
    ["an if sent to the background", `if true; then cd sub; fi &\n${APPLY}`],
  ])("keeps the directory past %s, which runs in a subshell", (_name, script) => {
    expect(placements(script)).toEqual(["/s"]);
  });

  it("follows a cd inside a background list for the commands of that list", () => {
    const script = `cd sub && apply_patch <<'EOF' &\n${PATCH}\nEOF\n${APPLY}\n`;
    expect(placements(script)).toEqual(["/s/sub", "/s"]);
  });

  it("places a patch command fed by a compound command that moves", () => {
    const script = `if true; then cd sub; fi | apply_patch <<'EOF'\n${PATCH}\nEOF\n`;
    expect(placements(script)).toEqual(["/s"]);
  });

  it("starts every member of a pipeline in the pipeline's directory", () => {
    expect(placements(`cd sub; cat <<'EOF' | apply_patch\n${PATCH}\nEOF\n`)).toEqual(["/s/sub"]);
  });

  it("follows a cd inside a subshell for the rest of that subshell", () => {
    expect(placements(`(cd sub; cd deeper; ${APPLY}\n)`)).toEqual(["/s/sub/deeper"]);
  });
});

describe("readShellScript: branches", () => {
  it.each([
    ["cd || exit", `cd sub || exit 1\n${APPLY}`, ["/s/sub"]],
    ["cd || cd", `cd sub || cd other\n${APPLY}`, ["unknown"]],
    ["cd || a group that does not move", `cd sub || { echo no; exit 1; }\n${APPLY}`, ["/s/sub"]],
    ["a cd after || a test", `test -d sub || cd other\n${APPLY}`, ["unknown"]],
    ["a cd after && and another after ||", `test -d a && cd a || cd b\n${APPLY}`, ["unknown"]],
    ["a patch after || a command that does not move", `false || ${APPLY}`, ["/s"]],
    ["a patch after || a list that moved", `cd sub && false || ${APPLY}`, ["unknown"]],
    ["a cd in if's body", `if true; then cd sub; fi\n${APPLY}`, ["unknown"]],
    ["the same cd in both branches", `if a; then cd sub; else cd sub; fi\n${APPLY}`, ["/s/sub"]],
    [
      "different cds in the branches",
      `if a; then cd sub; else cd other; fi\n${APPLY}`,
      ["unknown"],
    ],
    ["a cd in the condition", `if cd sub; then echo in; fi\n${APPLY}`, ["/s/sub"]],
    [
      "a patch in else after a cd in the condition",
      `if cd sub; then :; else ${APPLY}\nfi`,
      ["unknown"],
    ],
    [
      "a patch in elif after a cd in the condition",
      `if cd sub; then :; elif true; then ${APPLY}\nfi`,
      ["unknown"],
    ],
    [
      "an else that does not move after a cd in the condition",
      `if cd sub; then :; else exit 1; fi\n${APPLY}`,
      ["/s/sub"],
    ],
    [
      "a cd in elif after a cd in the condition",
      `if cd a; then :; elif cd b; then :; fi\n${APPLY}`,
      ["unknown"],
    ],
    ["a patch after a negated cd", `if ! cd sub; then ${APPLY}\nfi`, ["unknown"]],
    ["a negated cd guarding an exit", `if ! cd sub; then exit 1; fi\n${APPLY}`, ["/s/sub"]],
    ["a patch after a negated cd and &&", `! cd sub && ${APPLY}`, ["unknown"]],
    ["a patch after a negated cd and ||", `! cd sub || ${APPLY}`, ["/s/sub"]],
    [
      "the same cd in every elif branch",
      `if a; then cd x; elif b; then cd x; else cd x; fi\n${APPLY}`,
      ["/s/x"],
    ],
    ["elif branches with no else", `if a; then cd x; elif b; then cd x; fi\n${APPLY}`, ["unknown"]],
    ["a patch in if's body", `if test -d sub; then cd sub && ${APPLY}\nfi`, ["/s/sub"]],
    ["a patch in else's body", `if false; then :; else cd sub && ${APPLY}\nfi`, ["/s/sub"]],
    ["a cd in a case branch", `case x in x) cd sub;; esac\n${APPLY}`, ["unknown"]],
    [
      "the same cd in every case branch",
      `case x in (a|b) cd sub;; *) cd sub;; esac\n${APPLY}`,
      ["unknown"],
    ],
    ["a patch in a case branch", `case x in x) cd sub && ${APPLY}\n;; esac`, ["/s/sub"]],
    ["a case branch fallen into", `case x in a) cd sub;& b) ${APPLY}\n;; esac`, ["unknown"]],
  ])("%s", (_name, script, expected) => {
    expect(placements(script)).toEqual(expected);
  });
});

describe("readShellScript: loops", () => {
  it.each([
    ["a cd in a for loop", `for d in a; do cd sub; done\n${APPLY}`, ["unknown"]],
    ["a cd in an until loop", `until false; do cd sub; done\n${APPLY}`, ["unknown"]],
    [
      "a cd in an arithmetic for",
      `for ((i = 0; i < 1; i++)); do cd sub; done\n${APPLY}`,
      ["unknown"],
    ],
    [
      "a pass that returns where it started",
      `for d in a; do cd sub && ${APPLY}\ncd ..; done`,
      ["/s/sub"],
    ],
    ["a pass that does not return", `for d in a b; do cd sub && ${APPLY}\ndone`, ["unknown"]],
    ["an absolute cd in the body", `for d in a b; do cd /abs && ${APPLY}\ndone`, ["/abs"]],
    ["a loop that does not move", `while read l; do ${APPLY}\ndone`, ["/s"]],
    ["a while condition that moves", `while cd sub; do cd ..; done\n${APPLY}`, ["unknown"]],
    [
      "a patch in an until loop whose condition moves",
      `until cd sub; do ${APPLY}\ndone`,
      ["unknown"],
    ],
    ["nested loops", `for a in x; do for b in y; do cd sub; done; done\n${APPLY}`, ["unknown"]],
    ["a select loop", `select d in a; do cd sub; break; done\n${APPLY}`, ["unknown"]],
    ["a for loop over the arguments", `for d\ndo cd sub; done\n${APPLY}`, ["unknown"]],
  ])("%s", (_name, script, expected) => {
    expect(placements(script)).toEqual(expected);
  });

  it("gives up on loops nested past its budget, rather than walking them for ever", () => {
    const depth = 24;
    const script = "for x in a; do cd /a; ".repeat(depth) + "cd b; done; ".repeat(depth) + APPLY;
    expect(placements(script)).toBe("unparsed");
  });
});

describe("readShellScript: what reads the patch", () => {
  it.each([
    [
      "a patch held in a variable",
      `PATCH=$(cat <<'EOF'\n${PATCH}\nEOF\n)\ncd sub && apply_patch "$PATCH"\n`,
    ],
    [
      "a patch staged in a file",
      `cat > /tmp/p <<'EOF'\n${PATCH}\nEOF\ncd sub && apply_patch < /tmp/p\n`,
    ],
    ["a patch in bash -c", `bash -c 'cd sub && apply_patch <<EOF\n${PATCH}\nEOF'\n`],
    ["a patch in eval", `eval 'cd sub; apply_patch <<EOF\n${PATCH}\nEOF'\n`],
    ["a heredoc on a group", `{ cd sub; apply_patch; } <<'EOF'\n${PATCH}\nEOF\n`],
    ["a pipeline into a subshell", `cat <<'EOF' | (cd sub && apply_patch)\n${PATCH}\nEOF\n`],
    ["a command named by a variable", `cd sub && $AP <<'EOF'\n${PATCH}\nEOF\n`],
  ])("reads %s as unread", (_name, script) => {
    expect(placements(script)).toEqual(["unread"]);
  });

  it.each([
    ["a path to apply_patch", `cd sub && ./bin/apply_patch <<'EOF'\n${PATCH}\nEOF\n`, "/s/sub"],
    ["command apply_patch", `cd sub && command apply_patch <<'EOF'\n${PATCH}\nEOF\n`, "/s/sub"],
    ["applypatch", `cd sub && applypatch <<'EOF'\n${PATCH}\nEOF\n`, "/s/sub"],
    ["a substitution that moves", `apply_patch "$(cd sub; cat <<'EOF'\n${PATCH}\nEOF\n)"\n`, "/s"],
    [
      "a substitution in a feeding command",
      `cd sub; echo "$(cat <<'EOF'\n${PATCH}\nEOF\n)" | apply_patch\n`,
      "/s/sub",
    ],
    ["a group feeding it", `{ cd other; cat <<'EOF'; } | apply_patch\n${PATCH}\nEOF\n`, "/s"],
  ])("places %s at the patch command's directory", (_name, script, expected) => {
    expect(placements(script)).toEqual([expected]);
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

  it.each([
    ["a regex", "[[ $x =~ ^(a|b)$ ]] && cd sub"],
    ["parentheses and operators", "[[ ( -d a ) || ( $a < $b ) ]]\ncd sub"],
    ["an expression over two lines", "[[ -d a &&\n  -d b ]] > /dev/null; cd sub"],
  ])("reads a [[ … ]] conditional holding %s as one command", (_name, script) => {
    expect(placements(`${script}\n${APPLY}`)).toEqual(["/s/sub"]);
  });

  it.each([
    ["an input", "while read f; do :; done < <(find . -name x)"],
    ["an output", "exec > >(tee log) 2>&1"],
    ["a scope", "cat < <(cd other; ls)"],
  ])("reads a process substitution as a redirection's target, as %s", (_name, script) => {
    expect(placements(`${script}\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("reads an arithmetic command", () => {
    expect(placements(`(( x = 1 << 2 ))\ncd sub && ${APPLY}`)).toEqual(["/s/sub"]);
  });

  it("answers outside between commands, and unread for text no patch command reads", () => {
    const script = `# a comment\n\ncd sub\napply_patch x\n`;
    const reading = readShellScript(script, SESSION);
    expect(reading).not.toBe("unparsed");
    if (reading === "unparsed") return;
    expect(reading.directoryAt(script.indexOf("comment"))).toEqual({ kind: "outside" });
    expect(reading.directoryAt(script.indexOf("\n\n") + 1)).toEqual({ kind: "outside" });
    expect(reading.directoryAt(script.indexOf("sub"))).toEqual({ kind: "unread" });
    expect(reading.directoryAt(script.indexOf(" x"))).toEqual({
      kind: "directory",
      path: "/s/sub",
    });
  });

  it("reads compound commands in their every form", () => {
    const script = [
      "while true; do break; done",
      "until false\ndo\n  break\ndone",
      "for x in a b # comment\ndo :; done",
      "for x; do :; done >/dev/null",
      "case $x in\n  (a|b) echo a ;;\n  c) ;;&\n  *) if x; then y; fi ;&\n  d) :\nesac",
      "if a\nthen\n  b\nelif c; then d\nelse\n  e\nfi 2>&1",
      "f() if a; then b; fi",
      `cd /abs && ${APPLY}`,
    ].join("\n");
    expect(placements(script)).toEqual(["/abs"]);
  });
});

describe("readShellScript: unparsed", () => {
  it.each([
    ["an unterminated [[", `[[ -d a\n${APPLY}`],
    ["an unterminated single quote", `cd 'sub && ${APPLY}`],
    ["an unterminated double quote", `cd "sub && ${APPLY}`],
    ["an unterminated substitution", `x=$(cd sub\n${APPLY}`],
    ["an unterminated backtick", "x=`cd sub\n" + APPLY],
    ["an unterminated parameter expansion", `x=\${HOME\n${APPLY}`],
    ["an unbalanced )", `cd sub)\n${APPLY}`],
    ["an unterminated subshell", `(cd sub\n${APPLY}`],
    ["a heredoc inside backticks", "x=`cat <<EOF\ncd sub\nEOF`\n" + APPLY],
    ["a redirection with no target", `cd sub >\n${APPLY}`],
    ["an if with no fi", `if true; then cd sub\n${APPLY}`],
    ["a loop with no done", `for x in a; do cd sub\n${APPLY}`],
    ["a case with no esac", `case x in a) cd sub;;\n${APPLY}`],
    ["a closing word with nothing to close", `fi\n${APPLY}`],
    ["a case terminator outside a case", `cd sub;;\n${APPLY}`],
    ["an && with nothing after it", `${APPLY}\ncd sub &&`],
    ["a pipe with nothing after it", `${APPLY}\ncd sub |`],
  ])("%s", (_name, script) => {
    expect(placements(script)).toBe("unparsed");
  });
});

describe("readShellScript: quoting", () => {
  const quotingAtHeader = (script: string) => {
    const reading = readShellScript(script, SESSION);
    if (reading === "unparsed") return "unparsed";
    return reading.quotingAt(script.indexOf("*** Update File"));
  };

  it.each([
    ["a quoted heredoc", `apply_patch <<'EOF'\n${PATCH}\nEOF`, "verbatim"],
    ["an unquoted heredoc", `apply_patch <<EOF\n${PATCH}\nEOF`, "heredoc"],
    ["a single-quoted argument", `apply_patch '${PATCH}'`, "single-quoted"],
    ["a double-quoted argument", `apply_patch "${PATCH}"`, "double-quoted"],
    [
      "a quoted heredoc in double quotes",
      `apply_patch "$(cat <<'EOF'\n${PATCH}\nEOF\n)"`,
      "verbatim",
    ],
    [
      "an unquoted heredoc in double quotes",
      `apply_patch "$(cat <<EOF\n${PATCH}\nEOF\n)"`,
      "heredoc",
    ],
  ])("tells a patch in %s", (_name, script, quoting) => {
    expect(quotingAtHeader(script)).toBe(quoting);
  });

  it.each([
    ["verbatim", String.raw`a \"b\" $c`, String.raw`a \"b\" $c`],
    ["double-quoted", String.raw`domain = \"d\" \$x \\ \n`, String.raw`domain = "d" $x \ \n`],
    ["heredoc", String.raw`a \"b\" \$x \\ \``, String.raw`a \"b\" $x \ ` + "`"],
    ["heredoc", "cost in $ and $'x'", "cost in $ and $'x'"],
    ["single-quoted", String.raw`a "b" $c \``, String.raw`a "b" $c \``],
    ["single-quoted", String.raw`prompt = "Don'\''t"`, `prompt = "Don't"`],
    ["single-quoted", `it'"'"'s`, "it's"],
    ["double-quoted", 'domain = "d"', "domain = d"],
    ["verbatim", "ends in \\", "ends in \\"],
  ] as const)("reads a line %s as the shell passes it", (quoting, line, read) => {
    expect(linesAsRead([line], quoting)).toEqual([read]);
  });

  it.each([
    ["double-quoted", "prompt = $text"],
    ["heredoc", "prompt = ${text}"],
    ["heredoc", "now = `date`"],
    ["single-quoted", `a '$b' c`],
  ] as const)("leaves out a %s line holding an expansion", (quoting, line) => {
    expect(linesAsRead(["kept", line], quoting)).toEqual(["kept"]);
  });

  it.each([
    ["single-quoted", "it's"],
    ["single-quoted", "a' b'"],
    ["double-quoted", 'a = "b'],
    ["double-quoted", "joined \\"],
    ["heredoc", "joined \\"],
  ] as const)("gives no line of a %s section once one leaves its quoting", (quoting, line) => {
    expect(linesAsRead(["first", line, "last"], quoting)).toEqual([]);
  });
});

/**
 * A reading of a POSIX shell script that tells, for an offset in it, which
 * directory the patch command reading that offset runs in.
 *
 * Codex reports a patch run through the shell as a `Bash` call carrying the
 * whole script, and a relative path in that patch is relative to wherever the
 * script had moved when `apply_patch` ran. This module lexes the script far
 * enough to follow `cd`: commands, quotes, heredocs, substitutions, scopes,
 * branches and loops. It is not a shell parser. Past what it reads, it
 * answers "unknown" rather than guessing, and a script it cannot lex at all
 * is "unparsed".
 *
 * - Text is placed only where a patch command reads it: the words and
 *   heredoc bodies of an `apply_patch` command, and the text of a command
 *   feeding one through a pipeline or a substitution in its words. Text that
 *   any other command holds, such as a variable, a file, `bash -c` or `eval`,
 *   is unknown, since this reading does not follow whatever reads it later.
 * - `cd DIR` with one literal operand (optionally after `-L`, `-P` or `--`)
 *   moves the directory, and is assumed to succeed; any other `cd`, and
 *   `pushd`, `popd`, `eval`, `source`, `.` or a function definition, makes
 *   it unknown. An absolute `cd` makes an unknown directory known again.
 * - The reading follows the path on which each command succeeds, so a
 *   negated `cd` fails on it. What runs only on the other path (after `||`,
 *   in `elif` and `else`, after a negated `cd` and `&&`, and on the path a
 *   loop's condition takes to end or skip it) starts where the shell stood
 *   when nothing had moved it, and from an unknown directory otherwise.
 * - `( … )`, `$( … )`, `<( … )` and `>( … )` are scopes: a `cd` inside one
 *   ends at its closing parenthesis. A list sent to the background, and every
 *   member of a pipeline but the last, run in subshells in bash and zsh
 *   alike. zsh runs a pipeline's last member in the current shell and bash
 *   does not, so a directory change there makes the directory after it
 *   unknown.
 * - `{ … }` and the separators `;`, newline and `&&` are followed in order.
 *   Where only one of several paths runs, after `||`, between the branches of
 *   `if` and `case`, and across the passes of a loop, the directory is kept
 *   when every path leaves it the same, and is unknown otherwise.
 * - Heredoc bodies, quoted strings, comments and the expression of a `[[ … ]]`
 *   are never read as commands. A heredoc body belongs to the command that
 *   opened it.
 * - The text a command reads is the script's after the shell's quoting, which
 *   the reading also tells: a patch in double quotes or in an unquoted heredoc
 *   has its backslash escapes removed and its `$` and backtick expansions run.
 */

import { basename, isAbsolute, resolve } from "node:path";

/** Where the patch command reading an offset runs. */
export type Placement =
  | { kind: "directory"; path: string }
  /** A patch command reads the offset from somewhere this reading cannot follow. */
  | { kind: "unknown" }
  /** A command holds the offset, and no patch command reads it: a variable, a file, `bash -c`. */
  | { kind: "unread" }
  /** No command holds the offset: it is in a comment or between commands. */
  | { kind: "outside" };

/** How the shell turns a stretch of the script into the text a command reads. */
export type Quoting =
  /** As written: in single quotes, in a quoted heredoc, or plain. */
  | "verbatim"
  /** In double quotes: a backslash escapes `$`, a backtick, `"` or itself, and `$` and backticks expand. */
  | "double-quoted"
  /** In an unquoted heredoc: a backslash escapes `$`, a backtick or itself, and `$` and backticks expand. */
  | "heredoc";

/** A script that could be lexed, able to place any offset in it. */
export interface ShellReading {
  directoryAt(offset: number): Placement;
  quotingAt(offset: number): Quoting;
}

/**
 * Read `script` as a POSIX shell script run from `sessionDir`, or return
 * `"unparsed"` when it holds an unterminated quote, substitution or backtick,
 * a heredoc inside backticks, a parenthesis that closes nothing, or any other
 * syntax error this reading can see.
 */
export function readShellScript(script: string, sessionDir: string): ShellReading | "unparsed" {
  let extents: Extent[];
  let quoted: QuotedSpan[];
  try {
    const parser = new ScriptParser(script);
    const walk = new DirectoryWalk(WALK_BUDGET_FLOOR + WALK_BUDGET_PER_CHARACTER * script.length);
    walk.list(parser.parse(), sessionDir);
    extents = walk.extents;
    quoted = parser.quoted;
  } catch {
    // An Unparsed signal, or a script nested past the stack: either way the
    // script cannot be read, and "unparsed" is the answer that fails safe.
    return "unparsed";
  }
  return {
    directoryAt(offset: number): Placement {
      const holder = innermost(extents, offset);
      if (!holder) {
        return { kind: "outside" };
      }
      if (!holder.read) {
        return { kind: "unread" };
      }
      return holder.directory === null
        ? { kind: "unknown" }
        : { kind: "directory", path: holder.directory };
    },
    quotingAt(offset: number): Quoting {
      return innermost(quoted, offset)?.quoting ?? "verbatim";
    },
  };
}

/** The shortest of `spans` holding `offset`, which is the innermost when they nest. */
function innermost<T extends { start: number; end: number }>(spans: T[], offset: number): T | null {
  let holder: T | null = null;
  for (const span of spans) {
    if (span.start <= offset && offset < span.end) {
      if (!holder || span.end - span.start < holder.end - holder.start) {
        holder = span;
      }
    }
  }
  return holder;
}

/**
 * A line of the script as a command reads it, given the quoting it is in, or
 * null when an expansion, or a quote closing mid-line, makes that unknown.
 */
export function lineAsRead(line: string, quoting: Quoting): string | null {
  if (quoting === "verbatim") {
    return line;
  }
  const escapable = quoting === "double-quoted" ? '$`"\\' : "$`\\";
  let read = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    const next = line[index + 1];
    if (char === "\\" && next !== undefined && escapable.includes(next)) {
      read += next;
      index++;
    } else if (
      char === "`" ||
      (char === "$" && next !== undefined && /[\w{(@*#?$!-]/.test(next)) ||
      (char === '"' && quoting === "double-quoted")
    ) {
      return null;
    } else {
      read += char;
    }
  }
  return read;
}

// ---------------------------------------------------------------------------
// Syntax tree

interface Word {
  /** The word with quotes removed; an expansion is kept as written. */
  value: string;
  start: number;
  end: number;
  /** Some part of the word was quoted or escaped. */
  quoted: boolean;
  /** The word holds a `$` or backtick expansion. */
  expands: boolean;
  /** The word holds an unquoted glob or brace character. */
  pattern: boolean;
  /** The word starts with an unquoted `~` or `=` (tilde, or zsh's equals expansion). */
  expandsHome: boolean;
  /** The word is a `NAME=value` assignment. */
  assignment: boolean;
  /** The command lists of the substitutions inside the word. */
  substitutions: CommandList[];
}

/**
 * A simple command, or the words and redirections of a compound command's
 * head (a `for` loop's words, a `case` subject or patterns) or tail.
 */
interface SimpleCommand {
  kind: "simple";
  words: Word[];
  /** The command's own text, from its first token to the end of its last. */
  start: number;
  end: number;
  /** The bodies of the heredocs the command opened. */
  heredocs: Array<[number, number]>;
  /** Substitutions in its words and redirections, which run before it. */
  substitutions: CommandList[];
}

interface CompoundCommand {
  kind: "subshell" | "group";
  body: CommandList;
  /** The redirections after the closing `)` or `}`, as a command with no words. */
  tail: SimpleCommand;
}

interface IfCommand {
  kind: "if";
  /** The `if` condition and each `elif` one, with the body each guards. */
  clauses: Array<{ condition: CommandList; body: CommandList }>;
  otherwise: CommandList | null;
  tail: SimpleCommand;
}

interface CaseCommand {
  kind: "case";
  subject: SimpleCommand;
  /** `fallsThrough` when the branch ends with `;&` or `;;&` rather than `;;`. */
  branches: Array<{ patterns: SimpleCommand; body: CommandList; fallsThrough: boolean }>;
  tail: SimpleCommand;
}

interface LoopCommand {
  kind: "loop";
  /** A `for` or `select` loop's words, expanded once before the first pass. */
  head: SimpleCommand | null;
  /** A `while` or `until` loop's condition, run before each pass and once more to end it. */
  condition: CommandList | null;
  /** An `until` loop, whose body runs while its condition fails. */
  until: boolean;
  body: CommandList;
  tail: SimpleCommand;
}

interface FunctionDefinition {
  kind: "function";
  body: Command;
}

type Command =
  SimpleCommand | CompoundCommand | IfCommand | CaseCommand | LoopCommand | FunctionDefinition;

interface Pipeline {
  commands: Command[];
  /** The pipeline follows `!`, which inverts its status. */
  negated: boolean;
}

interface AndOrList {
  pipelines: Pipeline[];
  /** The operator before each pipeline after the first. */
  operators: Array<"&&" | "||">;
  background: boolean;
}

interface CommandList {
  items: AndOrList[];
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  /** The delimiter was quoted, so the body is read verbatim. */
  quoted: boolean;
  owner: SimpleCommand;
}

/** A stretch of the script in quotes or in a heredoc, and how the shell reads it. */
interface QuotedSpan {
  start: number;
  end: number;
  quoting: Quoting;
}

/** The script cannot be read: a syntax error, or a walk past its budget. */
class Unparsed extends Error {}

// ---------------------------------------------------------------------------
// Lexer and parser

/** Reserved words another command follows on the same line. */
const COMMAND_PREFIXES = new Set(["!", "time"]);

/** Reserved words that end or divide a compound command, and never name a command. */
const CLOSING_WORDS = new Set(["then", "elif", "else", "fi", "do", "done", "esac", "}"]);

/** Characters that end an unquoted word. */
const WORD_BREAKS = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

const REDIRECTION_OPERATORS = ["<<<", "<<-", "<<", "<&", "<>", "<", ">>", ">&", ">|", ">"];

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

class ScriptParser {
  /** The quoted strings and heredoc bodies read so far. */
  readonly quoted: QuotedSpan[] = [];
  private pos = 0;
  private readonly pending: PendingHeredoc[] = [];

  constructor(private readonly src: string) {}

  parse(): CommandList {
    return this.parseList([]);
  }

  /**
   * Commands up to one of `terminators`, which is left unread: a reserved
   * word where a command would start, `)`, or `;;` for a case branch, which
   * `;&` and `;;&` end too. With no terminator, the list runs to the end.
   */
  private parseList(terminators: readonly string[]): CommandList {
    const items: AndOrList[] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.atEnd()) {
        if (terminators.length > 0) {
          throw new Unparsed();
        }
        break;
      }
      if (this.atTerminator(terminators)) {
        break;
      }
      const item = this.parseAndOr();
      items.push(item);
      this.skipBlanks();
      if (this.startsWith("&") && !this.startsWith("&&")) {
        item.background = true;
        this.pos++;
      } else if (this.startsWith(";;") || this.startsWith(";&")) {
        if (!terminators.includes(";;")) {
          throw new Unparsed();
        }
      } else if (this.startsWith(";")) {
        this.pos++;
      } else if (
        !this.atEnd() &&
        !["\n", "#"].includes(this.src[this.pos]!) &&
        !this.atTerminator(terminators)
      ) {
        throw new Unparsed();
      }
    }
    return { items };
  }

  private atTerminator(terminators: readonly string[]): boolean {
    return terminators.some((terminator) => {
      if (terminator === ")") {
        return this.startsWith(")");
      }
      if (terminator === ";;") {
        return this.startsWith(";;") || this.startsWith(";&");
      }
      return this.atReservedWord(terminator);
    });
  }

  private parseAndOr(): AndOrList {
    const item: AndOrList = { pipelines: [this.parsePipeline()], operators: [], background: false };
    for (;;) {
      this.skipBlanks();
      const operator = this.startsWith("&&") ? "&&" : this.startsWith("||") ? "||" : null;
      if (operator === null) {
        return item;
      }
      this.pos += 2;
      this.skipLinebreaks();
      item.operators.push(operator);
      item.pipelines.push(this.parsePipeline());
    }
  }

  private parsePipeline(): Pipeline {
    this.skipBlanks();
    const negated = this.atReservedWord("!");
    if (negated) {
      this.pos++;
    }
    const commands = [this.parseCommand()];
    for (;;) {
      this.skipBlanks();
      if (!this.startsWith("|") || this.startsWith("||")) {
        break;
      }
      this.pos += this.startsWith("|&") ? 2 : 1;
      this.skipLinebreaks();
      commands.push(this.parseCommand());
    }
    return { commands, negated };
  }

  private parseCommand(): Command {
    this.skipBlanks();
    if (this.startsWith("((")) {
      const command = this.emptyCommand();
      this.pos += 2;
      this.skipArithmetic();
      command.end = this.pos;
      return command;
    }
    if (this.startsWith("(")) {
      this.pos++;
      const body = this.parseList([")"]);
      this.pos++;
      return { kind: "subshell", body, tail: this.parseTail() };
    }
    if (this.atReservedWord("{")) {
      this.pos++;
      const body = this.parseList(["}"]);
      this.pos++;
      return { kind: "group", body, tail: this.parseTail() };
    }
    if (!this.atWordStart() || this.atRedirection()) {
      const command = this.parseSimple(null);
      if (command.kind === "simple" && command.end === command.start) {
        throw new Unparsed(); // an operator where a command should be
      }
      return command;
    }
    const first = this.readWord();
    const reserved = first.quoted || first.expands ? null : first.value;
    if (reserved !== null && COMMAND_PREFIXES.has(reserved)) {
      if (reserved === "time") {
        this.skipBlanks();
        if (/^-p(?![^\s;&|<>()])/.test(this.src.slice(this.pos, this.pos + 3))) {
          this.pos += 2;
        }
      }
      return this.parseCommand();
    }
    if (reserved !== null && CLOSING_WORDS.has(reserved)) {
      throw new Unparsed();
    }
    switch (reserved) {
      case "if":
        return this.parseIf();
      case "while":
      case "until":
        return this.parseWhile(reserved === "until");
      case "for":
      case "select":
        return this.parseFor();
      case "case":
        return this.parseCase();
      case "[[":
        return this.parseConditional(first);
      case "function":
        this.skipBlanks();
        if (!this.atWordStart()) {
          throw new Unparsed();
        }
        this.readWord();
        return this.parseFunctionBody();
    }
    return this.parseSimple(first);
  }

  private parseIf(): IfCommand {
    const clauses: IfCommand["clauses"] = [];
    for (;;) {
      const condition = this.parseList(["then"]);
      this.readReserved("then");
      clauses.push({ condition, body: this.parseList(["elif", "else", "fi"]) });
      if (this.atReservedWord("elif")) {
        this.readReserved("elif");
        continue;
      }
      let otherwise: CommandList | null = null;
      if (this.atReservedWord("else")) {
        this.readReserved("else");
        otherwise = this.parseList(["fi"]);
      }
      this.readReserved("fi");
      return { kind: "if", clauses, otherwise, tail: this.parseTail() };
    }
  }

  private parseWhile(until: boolean): LoopCommand {
    const condition = this.parseList(["do"]);
    this.readReserved("do");
    const body = this.parseList(["done"]);
    this.readReserved("done");
    return { kind: "loop", head: null, condition, until, body, tail: this.parseTail() };
  }

  /** `for NAME [in WORDS]; do … done`, `for (( … )); do … done`, and `select` alike. */
  private parseFor(): LoopCommand {
    this.skipBlanks();
    const head = this.emptyCommand();
    if (this.startsWith("((")) {
      this.pos += 2;
      this.skipArithmetic();
      head.end = this.pos;
    } else {
      if (!this.atWordStart()) {
        throw new Unparsed();
      }
      const name = this.readWord();
      head.start = name.start;
      head.end = name.end;
      this.skipLinebreaks();
      if (this.atReservedWord("in")) {
        this.pos += 2;
        for (;;) {
          this.skipBlanks();
          if (!this.atWordStart()) {
            break;
          }
          addWord(head, this.readWord());
        }
      }
    }
    this.skipBlanks();
    if (this.startsWith(";") && !this.startsWith(";;")) {
      this.pos++;
    }
    this.skipLinebreaks();
    this.readReserved("do");
    const body = this.parseList(["done"]);
    this.readReserved("done");
    return { kind: "loop", head, condition: null, until: false, body, tail: this.parseTail() };
  }

  private parseCase(): CaseCommand {
    this.skipBlanks();
    if (!this.atWordStart()) {
      throw new Unparsed();
    }
    const subject = this.emptyCommand();
    addWord(subject, this.readWord());
    this.skipLinebreaks();
    this.readReserved("in");
    const branches: CaseCommand["branches"] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.atReservedWord("esac")) {
        this.readReserved("esac");
        return { kind: "case", subject, branches, tail: this.parseTail() };
      }
      const patterns = this.emptyCommand();
      if (this.startsWith("(")) {
        this.pos++;
      }
      for (;;) {
        this.skipBlanks();
        if (!this.atWordStart()) {
          throw new Unparsed();
        }
        addWord(patterns, this.readWord());
        this.skipBlanks();
        if (this.startsWith(")")) {
          this.pos++;
          break;
        }
        if (!this.startsWith("|")) {
          throw new Unparsed();
        }
        this.pos++;
      }
      const body = this.parseList([";;", "esac"]);
      const terminator = [";;&", ";;", ";&"].find((candidate) => this.startsWith(candidate));
      this.pos += terminator?.length ?? 0;
      branches.push({ patterns, body, fallsThrough: terminator === ";;&" || terminator === ";&" });
    }
  }

  /** The words and redirections of a simple command, `first` already read. */
  private parseSimple(first: Word | null): Command {
    const command = this.emptyCommand();
    if (first) {
      command.start = first.start;
      addWord(command, first);
    }
    for (;;) {
      this.skipBlanks();
      if (this.atEnd()) {
        break;
      }
      const char = this.src[this.pos]!;
      if (char === "#") {
        this.skipComment();
        break;
      }
      if (this.startsWith("<(") || this.startsWith(">(")) {
        const start = this.pos;
        this.pos += 2;
        const substitution = this.parseList([")"]);
        this.pos++;
        addWord(command, {
          ...bareWord(start, this.pos),
          expands: true,
          substitutions: [substitution],
        });
        continue;
      }
      if (this.atRedirection()) {
        this.readRedirection(command);
        continue;
      }
      if (char === "(") {
        if (
          command.words.length === 1 &&
          /^\(\s*\)/.test(this.src.slice(this.pos, this.pos + 64))
        ) {
          return this.parseFunctionBody(); // NAME ( ) BODY
        }
        throw new Unparsed();
      }
      if (WORD_BREAKS.has(char)) {
        break;
      }
      addWord(command, this.readWord());
    }
    return command;
  }

  /**
   * A `[[ … ]]` conditional, `[[` already read, as one command. Inside it,
   * parentheses, `<`, `>`, `&&`, `||` and `|` belong to the expression (a
   * regex after `=~` among them), and a newline does not end it.
   */
  private parseConditional(first: Word): SimpleCommand {
    const command = this.emptyCommand();
    command.start = first.start;
    addWord(command, first);
    for (;;) {
      this.skipLinebreaks();
      if (this.atEnd()) {
        throw new Unparsed();
      }
      if (this.atReservedWord("]]")) {
        addWord(command, this.readWord());
        break;
      }
      const char = this.src[this.pos]!;
      if (char === ";") {
        throw new Unparsed();
      }
      if (WORD_BREAKS.has(char)) {
        this.pos++;
        addWord(command, bareWord(this.pos - 1, this.pos));
      } else {
        addWord(command, this.readWord());
      }
    }
    for (;;) {
      this.skipBlanks();
      if (!this.atRedirection()) {
        return command;
      }
      this.readRedirection(command);
    }
  }

  /** The redirections after a compound command's closing word, and nothing else. */
  private parseTail(): SimpleCommand {
    const tail = this.emptyCommand();
    for (;;) {
      this.skipBlanks();
      if (this.startsWith("<(") || this.startsWith(">(") || !this.atRedirection()) {
        return tail;
      }
      this.readRedirection(tail);
    }
  }

  /** The body of a function whose name was read, with its optional `()`. */
  private parseFunctionBody(): FunctionDefinition {
    this.skipBlanks();
    const parentheses = /^\(\s*\)/.exec(this.src.slice(this.pos, this.pos + 64));
    if (parentheses) {
      this.pos += parentheses[0].length;
    }
    this.skipLinebreaks();
    return { kind: "function", body: this.parseCommand() };
  }

  private emptyCommand(): SimpleCommand {
    return {
      kind: "simple",
      words: [],
      start: this.pos,
      end: this.pos,
      heredocs: [],
      substitutions: [],
    };
  }

  private readReserved(word: string): void {
    if (!this.atReservedWord(word)) {
      throw new Unparsed();
    }
    this.pos += word.length;
  }

  private atRedirection(): boolean {
    return /^(?:\d*[<>]|&>)/.test(this.src.slice(this.pos, this.pos + 24));
  }

  private readRedirection(command: SimpleCommand): void {
    while (/\d/.test(this.src[this.pos] ?? "")) {
      this.pos++;
    }
    let operator: string;
    if (this.startsWith("&>")) {
      operator = this.startsWith("&>>") ? "&>>" : "&>";
    } else {
      operator = REDIRECTION_OPERATORS.find((candidate) => this.startsWith(candidate))!;
    }
    this.pos += operator.length;
    this.skipBlanks();
    const heredoc = operator === "<<" || operator === "<<-";
    if (!heredoc && (this.startsWith("<(") || this.startsWith(">("))) {
      // A process substitution as the target, as in `done < <(find …)`.
      this.pos += 2;
      command.substitutions.push(this.parseList([")"]));
      this.pos++;
      command.end = this.pos;
      return;
    }
    if (!this.atWordStart()) {
      throw new Unparsed();
    }
    const target = this.readWord();
    command.end = target.end;
    command.substitutions.push(...target.substitutions);
    if (heredoc) {
      this.pending.push({
        delimiter: target.value,
        stripTabs: operator === "<<-",
        quoted: target.quoted,
        owner: command,
      });
    }
  }

  /** Past a newline, the bodies of the heredocs opened on the line it ends. */
  private consumeNewline(): void {
    this.pos++;
    for (const heredoc of this.pending.splice(0)) {
      const bodyStart = this.pos;
      let bodyEnd = this.src.length;
      while (this.pos < this.src.length) {
        const newline = this.src.indexOf("\n", this.pos);
        const lineEnd = newline === -1 ? this.src.length : newline;
        const next = newline === -1 ? this.src.length : newline + 1;
        let line = this.src.slice(this.pos, lineEnd);
        if (heredoc.stripTabs) {
          line = line.replace(/^\t+/, "");
        }
        if (line === heredoc.delimiter) {
          bodyEnd = this.pos;
          this.pos = next;
          break;
        }
        this.pos = next;
      }
      heredoc.owner.heredocs.push([bodyStart, bodyEnd]);
      this.quoted.push({
        start: bodyStart,
        end: bodyEnd,
        quoting: heredoc.quoted ? "verbatim" : "heredoc",
      });
    }
  }

  private readWord(): Word {
    const word = bareWord(this.pos, this.pos);
    while (!this.atEnd()) {
      const char = this.src[this.pos]!;
      if (WORD_BREAKS.has(char)) {
        if (
          char === "(" &&
          /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(this.src.slice(word.start, this.pos))
        ) {
          this.skipArrayValue(); // NAME=( … )
          word.expands = true;
          continue;
        }
        break;
      }
      if (char === "\\") {
        const escaped = this.src[this.pos + 1];
        this.pos = Math.min(this.pos + 2, this.src.length);
        if (escaped !== "\n") {
          word.quoted = true;
          word.value += escaped ?? "";
        }
      } else if (char === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) {
          throw new Unparsed();
        }
        word.value += this.src.slice(this.pos + 1, close);
        word.quoted = true;
        this.quoted.push({ start: this.pos, end: close + 1, quoting: "verbatim" });
        this.pos = close + 1;
      } else if (char === '"') {
        this.readDoubleQuoted(word);
      } else if (char === "$") {
        this.readDollar(word, false);
      } else if (char === "`") {
        this.skipBackticks();
        word.expands = true;
      } else {
        if ("*?[{}".includes(char)) {
          word.pattern = true;
        }
        if ((char === "~" || char === "=") && this.pos === word.start) {
          word.expandsHome = true;
        }
        word.value += char;
        this.pos++;
      }
    }
    word.end = this.pos;
    word.assignment = ASSIGNMENT_PREFIX.test(this.src.slice(word.start, word.end));
    return word;
  }

  private readDoubleQuoted(word: Word): void {
    word.quoted = true;
    const start = this.pos;
    this.pos++;
    for (;;) {
      if (this.atEnd()) {
        throw new Unparsed();
      }
      const char = this.src[this.pos]!;
      if (char === '"') {
        this.pos++;
        this.quoted.push({ start, end: this.pos, quoting: "double-quoted" });
        return;
      }
      if (char === "\\") {
        const escaped = this.src[this.pos + 1];
        if (escaped === "\n") {
          this.pos += 2;
        } else if (escaped !== undefined && '$`"\\'.includes(escaped)) {
          word.value += escaped;
          this.pos += 2;
        } else {
          word.value += char;
          this.pos++;
        }
      } else if (char === "$") {
        this.readDollar(word, true);
      } else if (char === "`") {
        this.skipBackticks();
        word.expands = true;
      } else {
        word.value += char;
        this.pos++;
      }
    }
  }

  /** A `$` construct: `$'…'`, `$"…"`, `$(( … ))`, `$( … )`, `${ … }`, or a parameter. */
  private readDollar(word: Word, inDoubleQuotes: boolean): void {
    const next = this.src[this.pos + 1];
    word.expands = true;
    if (next === "'" && !inDoubleQuotes) {
      this.pos += 2;
      for (;;) {
        if (this.atEnd()) {
          throw new Unparsed();
        }
        const char = this.src[this.pos]!;
        this.pos += char === "\\" ? 2 : 1;
        if (char === "'") {
          break;
        }
        word.value += char;
      }
      word.quoted = true;
    } else if (next === '"' && !inDoubleQuotes) {
      this.pos++;
      this.readDoubleQuoted(word);
    } else if (next === "(" && this.src[this.pos + 2] === "(") {
      this.pos += 3;
      this.skipArithmetic();
    } else if (next === "(") {
      this.pos += 2;
      word.substitutions.push(this.parseList([")"]));
      this.pos++;
    } else if (next === "{") {
      this.pos += 2;
      this.skipParameterExpansion(word);
    } else {
      word.value += "$";
      this.pos++;
    }
  }

  /** Past the closing `}` of a `${ … }`, collecting the substitutions inside it. */
  private skipParameterExpansion(word: Word): void {
    for (;;) {
      if (this.atEnd()) {
        throw new Unparsed();
      }
      const char = this.src[this.pos]!;
      if (char === "}") {
        this.pos++;
        return;
      }
      if (char === "\\") {
        this.pos += 2;
      } else if (char === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) {
          throw new Unparsed();
        }
        this.pos = close + 1;
      } else if (char === '"') {
        const inner = bareWord(this.pos, this.pos);
        this.readDoubleQuoted(inner);
        word.substitutions.push(...inner.substitutions);
      } else if (char === "$") {
        const inner = bareWord(this.pos, this.pos);
        this.readDollar(inner, true);
        word.substitutions.push(...inner.substitutions);
      } else if (char === "`") {
        this.skipBackticks();
      } else {
        this.pos++;
      }
    }
  }

  /** Past the `))` closing an arithmetic expansion or command whose `((` was read. */
  private skipArithmetic(): void {
    let depth = 2;
    while (depth > 0) {
      if (this.atEnd()) {
        throw new Unparsed();
      }
      const char = this.src[this.pos]!;
      if (char === "\\") {
        this.pos++;
      } else if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth--;
      }
      this.pos++;
    }
  }

  /** Past the `)` closing an array assignment's value list. */
  private skipArrayValue(): void {
    this.pos++;
    for (;;) {
      this.skipLinebreaks();
      if (this.atEnd()) {
        throw new Unparsed();
      }
      if (this.src[this.pos] === ")") {
        this.pos++;
        return;
      }
      if (!this.atWordStart()) {
        throw new Unparsed();
      }
      this.readWord();
    }
  }

  /**
   * Past a backtick substitution. Its commands run in a subshell, so a `cd`
   * inside cannot move the script, and it is not read; a heredoc inside it
   * would need that reading, so the script is unparsed.
   */
  private skipBackticks(): void {
    const start = this.pos + 1;
    this.pos++;
    for (;;) {
      if (this.atEnd()) {
        throw new Unparsed();
      }
      const char = this.src[this.pos]!;
      if (char === "`") {
        break;
      }
      this.pos += char === "\\" ? 2 : 1;
    }
    const body = this.src.slice(start, this.pos);
    this.pos++;
    if (/(?<!<)<<(?!<)/.test(body)) {
      throw new Unparsed();
    }
  }

  private skipBlanks(): void {
    for (;;) {
      const char = this.src[this.pos];
      if (char === " " || char === "\t") {
        this.pos++;
      } else if (char === "\\" && this.src[this.pos + 1] === "\n") {
        this.pos += 2;
      } else {
        return;
      }
    }
  }

  private skipComment(): void {
    const newline = this.src.indexOf("\n", this.pos);
    this.pos = newline === -1 ? this.src.length : newline;
  }

  /** Blanks, comments and newlines, reading heredoc bodies at each newline. */
  private skipLinebreaks(): void {
    for (;;) {
      this.skipBlanks();
      const char = this.src[this.pos];
      if (char === "#") {
        this.skipComment();
      } else if (char === "\n") {
        this.consumeNewline();
      } else {
        return;
      }
    }
  }

  private atWordStart(): boolean {
    const char = this.src[this.pos];
    return char !== undefined && char !== "#" && !WORD_BREAKS.has(char);
  }

  /** A reserved word (`{`, `fi`, `done`, …) standing alone at the current position. */
  private atReservedWord(reserved: string): boolean {
    if (!this.startsWith(reserved)) {
      return false;
    }
    const after = this.src[this.pos + reserved.length];
    return after === undefined || WORD_BREAKS.has(after);
  }

  private startsWith(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }
}

function bareWord(start: number, end: number): Word {
  return {
    value: "",
    start,
    end,
    quoted: false,
    expands: false,
    pattern: false,
    expandsHome: false,
    assignment: false,
    substitutions: [],
  };
}

function isReservedWord(word: Word, reserved: Set<string>): boolean {
  return !word.quoted && !word.expands && reserved.has(word.value);
}

function addWord(command: SimpleCommand, word: Word): void {
  command.words.push(word);
  command.substitutions.push(...word.substitutions);
  command.end = word.end;
}

// ---------------------------------------------------------------------------
// The directory walk

/**
 * A directory the reading cannot tell. Each one differs from every other, so
 * the walk can see that a command moved the shell even when it knows neither
 * where from nor where to.
 */
class UnknownDirectory {}

type Directory = string | UnknownDirectory;

/** A command's stretch of the script, and the directory of the patch command reading it, if one does. */
interface Extent {
  start: number;
  end: number;
  /** A patch command reads the stretch. */
  read: boolean;
  /** Where that patch command runs; null is unknown. */
  directory: string | null;
}

/**
 * Where a list leaves the shell on the path the reading follows, on which
 * each command succeeds, and how the list exits on that path: a negated `cd`
 * fails on it. `moved` says whether the list moved the shell on the way,
 * which decides where a path taken on the other status starts.
 */
interface Outcome {
  after: Directory;
  status: "success" | "failure";
  moved: boolean;
}

type DirectoryEffect = { kind: "none" } | { kind: "unknown" } | { kind: "cd"; operand: string };

const UNKNOWN_EFFECT_COMMANDS = new Set(["pushd", "popd", "eval", "source", "."]);

/**
 * The longest directory the walk follows. `cd` itself refuses a longer path
 * on every system, and the bound keeps a script of chained relative `cd`s
 * linear to read.
 */
const PATH_MAX = 4096;

/** The names `apply_patch` is run by, as Codex puts it on the `PATH`. */
const PATCH_COMMANDS = new Set(["apply_patch", "applypatch"]);

/**
 * How many commands a walk may visit: a floor, plus a number per character of
 * the script. A loop whose passes start in different directories is walked
 * twice, so loops nested deep enough could otherwise cost time exponential in
 * their depth; a script past the budget is unparsed.
 */
const WALK_BUDGET_FLOOR = 100_000;
const WALK_BUDGET_PER_CHARACTER = 16;

class DirectoryWalk {
  readonly extents: Extent[] = [];
  /** The directory of the patch command reading the text being walked, if one does. */
  private reader: Directory | undefined;
  private steps = 0;

  constructor(private readonly budget: number) {}

  list(list: CommandList, directory: Directory): Directory {
    return this.run(list, directory).after;
  }

  /** A list, with the status its last and-or list exits with. */
  private run(list: CommandList, directory: Directory): Outcome {
    let outcome: Outcome = { after: directory, status: "success", moved: false };
    for (const item of list.items) {
      const next = this.andOr(item, outcome.after);
      // A list sent to the background runs in a subshell, in bash and zsh
      // alike, and the shell goes on at once, with success.
      outcome = item.background ? { ...outcome, status: "success", moved: false } : next;
    }
    return outcome;
  }

  private andOr(item: AndOrList, directory: Directory): Outcome {
    let outcome = this.pipeline(item.pipelines[0]!, directory);
    item.operators.forEach((operator, index) => {
      // `&&` runs the pipeline after it when what came before succeeded, `||` when it failed.
      const on = operator === "&&" ? "success" : "failure";
      const next = this.pipeline(item.pipelines[index + 1]!, branchStart(outcome, on));
      if (outcome.status === on) {
        outcome = { ...next, moved: outcome.moved || next.moved };
      } else if (next.moved) {
        // It runs off the followed path. When it does not move the shell
        // (`cd sub || exit 1`), the directory is the one the followed path
        // reached; when it does, either may be the one in effect after it.
        outcome = { ...outcome, after: new UnknownDirectory() };
      }
    });
    return outcome;
  }

  /**
   * Every member of a pipeline starts in the directory the pipeline starts
   * in. All but the last run in subshells; zsh runs the last in the current
   * shell and bash does not, so a directory change there is unknown after it.
   * When a member is a patch command, the other members feed it.
   */
  private pipeline(pipeline: Pipeline, directory: Directory): Outcome {
    const after = this.members(pipeline.commands, directory);
    return {
      after,
      status: pipeline.negated ? "failure" : "success",
      moved: after !== directory,
    };
  }

  private members(commands: Command[], directory: Directory): Directory {
    if (commands.length === 1) {
      return this.command(commands[0]!, directory);
    }
    const reader = this.reader;
    if (commands.some((command) => command.kind === "simple" && isPatchCommand(command.words))) {
      this.reader = directory;
    }
    let last: Directory = directory;
    for (const command of commands) {
      last = this.command(command, directory);
    }
    this.reader = reader;
    return last === directory ? directory : new UnknownDirectory();
  }

  private command(command: Command, directory: Directory): Directory {
    switch (command.kind) {
      case "simple":
        return this.simple(command, directory);
      case "subshell":
        this.text(command.tail, directory, false);
        this.list(command.body, directory);
        return directory;
      case "group":
        this.text(command.tail, directory, false);
        return this.list(command.body, directory);
      case "if":
        return this.ifCommand(command, directory);
      case "case":
        return this.caseCommand(command, directory);
      case "loop":
        return this.loop(command, directory);
      case "function":
        // The body runs whenever the function is called, from wherever.
        this.command(command.body, new UnknownDirectory());
        return new UnknownDirectory();
    }
  }

  /** Each condition runs after the ones before it failed; one body, or none, runs. */
  private ifCommand(command: IfCommand, directory: Directory): Directory {
    this.text(command.tail, directory, false);
    return this.clauses(command.clauses, command.otherwise, directory);
  }

  /**
   * The first clause, and the rest (the `elif` clauses after it and the `else`
   * body), which runs when the first clause's condition fails, as in `if C;
   * then BODY; else REST; fi`. When the condition does not move the shell,
   * both paths start where it ends. When it does, the one it takes off the
   * followed path starts from an unknown directory and, as after `||`, keeps
   * the directory the other reached unless it moves the shell itself.
   */
  private clauses(
    clauses: IfCommand["clauses"],
    otherwise: CommandList | null,
    directory: Directory,
  ): Directory {
    const [clause, ...rest] = clauses;
    if (!clause) {
      return otherwise ? this.list(otherwise, directory) : directory;
    }
    const checked = this.run(clause.condition, directory);
    const body = (start: Directory): Directory => this.list(clause.body, start);
    const remainder = (start: Directory): Directory => this.clauses(rest, otherwise, start);
    if (!checked.moved) {
      return common([body(checked.after), remainder(checked.after)]);
    }
    const followed = checked.status === "success" ? body : remainder;
    const other = checked.status === "success" ? remainder : body;
    const end = followed(checked.after);
    const start = new UnknownDirectory();
    return other(start) === start ? end : new UnknownDirectory();
  }

  /** One branch runs, or none; a branch fallen into may start where the one before ended. */
  private caseCommand(command: CaseCommand, directory: Directory): Directory {
    this.text(command.tail, directory, false);
    this.text(command.subject, directory, false);
    const ends: Directory[] = [directory];
    let fallenFrom: Directory | null = null;
    for (const branch of command.branches) {
      this.text(branch.patterns, directory, false);
      const start = fallenFrom === null ? directory : common([directory, fallenFrom]);
      const end = this.list(branch.body, start);
      ends.push(end);
      fallenFrom = branch.fallsThrough ? end : null;
    }
    return common(ends);
  }

  /**
   * A loop runs its body any number of times. When a pass ends where it
   * started, every pass does. Otherwise the passes after the first start
   * elsewhere, so the loop is walked again from an unknown directory, whose
   * placements then stand for every pass.
   */
  private loop(command: LoopCommand, directory: Directory): Directory {
    this.text(command.tail, directory, false);
    if (command.head) {
      this.text(command.head, directory, false);
    }
    const mark = this.extents.length;
    const first = this.pass(command, directory);
    if (first.next === directory) {
      return first.exit;
    }
    if (directory instanceof UnknownDirectory) {
      // From one unknown directory, the walk places text as it would from any other.
      return new UnknownDirectory();
    }
    this.extents.length = mark;
    const later = this.pass(command, new UnknownDirectory());
    return common([first.exit, later.exit]);
  }

  /**
   * One pass of a loop from `start`: where the next pass starts, and where
   * the loop ends if it ends instead, once a `for` loop's words run out, or
   * on the status of its condition that ends it: failure for `while`,
   * success for `until`.
   */
  private pass(command: LoopCommand, start: Directory): { next: Directory; exit: Directory } {
    if (!command.condition) {
      return { next: this.list(command.body, start), exit: start };
    }
    const checked = this.run(command.condition, start);
    const [runs, ends] = command.until
      ? (["failure", "success"] as const)
      : (["success", "failure"] as const);
    return {
      next: this.list(command.body, branchStart(checked, runs)),
      exit: branchStart(checked, ends),
    };
  }

  private simple(command: SimpleCommand, directory: Directory): Directory {
    this.text(command, directory, isPatchCommand(command.words));
    const effect = directoryEffect(command.words);
    switch (effect.kind) {
      case "none":
        return directory;
      case "unknown":
        return new UnknownDirectory();
      case "cd": {
        let moved: string;
        if (isAbsolute(effect.operand)) {
          moved = resolve(effect.operand);
        } else if (typeof directory === "string") {
          moved = resolve(directory, effect.operand);
        } else {
          return new UnknownDirectory();
        }
        return moved.length > PATH_MAX ? new UnknownDirectory() : moved;
      }
    }
  }

  /**
   * Place a command's words and heredoc bodies, after walking the
   * substitutions in them, which run first and in the same directory. A patch
   * command reads its own text and what its substitutions print; any other
   * command's text is read by the patch command it feeds, if there is one.
   */
  private text(command: SimpleCommand, directory: Directory, patchCommand: boolean): void {
    if (++this.steps > this.budget) {
      throw new Unparsed();
    }
    const reader = this.reader;
    if (patchCommand) {
      this.reader = directory;
    }
    for (const substitution of command.substitutions) {
      this.list(substitution, directory);
    }
    const read = this.reader !== undefined;
    const placed = typeof this.reader === "string" ? this.reader : null;
    this.reader = reader;
    if (command.end > command.start) {
      this.extents.push({ start: command.start, end: command.end, read, directory: placed });
    }
    for (const [start, end] of command.heredocs) {
      this.extents.push({ start, end, read, directory: placed });
    }
  }
}

/**
 * Where a path taken when a list exits with `on` starts: where the list left
 * the shell when that is the followed path's status or the list never moved
 * the shell, and an unknown directory otherwise, since the list may have
 * failed anywhere after it moved.
 */
function branchStart(outcome: Outcome, on: Outcome["status"]): Directory {
  return outcome.status === on || !outcome.moved ? outcome.after : new UnknownDirectory();
}

/** The directory every path leaves the shell in, or an unknown one when they differ. */
function common(ends: Directory[]): Directory {
  return ends.every((end) => end === ends[0]) ? ends[0]! : new UnknownDirectory();
}

/** The index of the word naming the command run, past assignments and `builtin` or `command`. */
function commandIndex(words: Word[]): number {
  let index = 0;
  while (words[index]?.assignment) {
    index++;
  }
  while (
    words[index] &&
    isReservedWord(words[index]!, new Set(["builtin", "command"])) &&
    !words[index + 1]?.value.startsWith("-")
  ) {
    index++;
  }
  return index;
}

function isPatchCommand(words: Word[]): boolean {
  const name = words[commandIndex(words)];
  return name !== undefined && !name.expands && PATCH_COMMANDS.has(basename(name.value));
}

/** What running a simple command does to the shell's working directory. */
function directoryEffect(words: Word[]): DirectoryEffect {
  const index = commandIndex(words);
  const name = words[index];
  if (!name || name.expands) {
    return { kind: "none" };
  }
  if (name.value === "cd") {
    return cdEffect(words.slice(index + 1));
  }
  if (UNKNOWN_EFFECT_COMMANDS.has(name.value)) {
    return { kind: "unknown" };
  }
  return { kind: "none" };
}

function cdEffect(args: Word[]): DirectoryEffect {
  let index = 0;
  while (args[index] && !args[index]!.expands && ["-L", "-P"].includes(args[index]!.value)) {
    index++;
  }
  let endOfOptions = false;
  if (args[index] && !args[index]!.expands && args[index]!.value === "--") {
    endOfOptions = true;
    index++;
  }
  const operands = args.slice(index);
  if (operands.length !== 1) {
    return { kind: "unknown" }; // `cd` alone goes home; zsh's `cd OLD NEW` substitutes
  }
  const operand = operands[0]!;
  if (
    operand.expands ||
    operand.pattern ||
    operand.expandsHome ||
    operand.value === "" ||
    (operand.value.startsWith("-") && !endOfOptions) ||
    /^\+\d+$/.test(operand.value)
  ) {
    return { kind: "unknown" };
  }
  return { kind: "cd", operand: operand.value };
}

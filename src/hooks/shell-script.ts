/**
 * A reading of a POSIX shell script that tells, for an offset in it, which
 * directory the command holding that offset runs in.
 *
 * Codex reports a patch run through the shell as a `Bash` call carrying the
 * whole script, and a relative path in that patch is relative to wherever the
 * script had moved when `apply_patch` ran. This module lexes the script far
 * enough to follow `cd`: commands, quotes, heredocs, substitutions and
 * scopes. It is not a shell parser. Past what it reads, it answers "unknown"
 * rather than guessing, and a script it cannot lex at all is "unparsed".
 *
 * - `cd DIR` with one literal operand (optionally after `-L`, `-P` or `--`)
 *   moves the directory; any other `cd`, and `pushd`, `popd`, `eval`,
 *   `source`, `.` or a function definition, makes it unknown. An absolute
 *   `cd` makes an unknown directory known again.
 * - `( … )`, `$( … )`, `<( … )` and `>( … )` are scopes: a `cd` inside one
 *   ends at its closing parenthesis. So do the members of a pipeline and a
 *   list sent to the background, which run in subshells; since zsh runs a
 *   pipeline's last command in the current shell, a directory change inside
 *   either makes the directory after it unknown.
 * - `{ … }`, the bodies of `if`, `while`, `until`, `for` and `case`, and the
 *   separators `&&`, `||`, `;` and newline are followed in order, as if every
 *   command ran.
 * - Heredoc bodies, quoted strings and comments are never read as commands.
 *   A heredoc body belongs to the command that opened it.
 */

import { isAbsolute, resolve } from "node:path";

/** Where the command holding an offset runs. */
export type Placement =
  | { kind: "directory"; path: string }
  /** The script moved somewhere this reading cannot follow. */
  | { kind: "unknown" }
  /** No command holds the offset: it is in a comment or between commands. */
  | { kind: "outside" };

/** A script that could be lexed, able to place any offset in it. */
export interface ShellReading {
  directoryAt(offset: number): Placement;
}

/**
 * Read `script` as a POSIX shell script run from `sessionDir`, or return
 * `"unparsed"` when it holds an unterminated quote, substitution or backtick,
 * a heredoc inside backticks, or a parenthesis that closes nothing.
 */
export function readShellScript(script: string, sessionDir: string): ShellReading | "unparsed" {
  let tree: CommandList;
  try {
    tree = new ScriptParser(script).parse();
  } catch {
    // An Unparsed signal, or a script nested past the stack: either way the
    // script cannot be read, and "unparsed" is the answer that fails safe.
    return "unparsed";
  }
  const extents: Extent[] = [];
  walkList(tree, sessionDir, extents);
  return {
    directoryAt(offset: number): Placement {
      let holder: Extent | null = null;
      for (const extent of extents) {
        if (extent.start <= offset && offset < extent.end) {
          if (!holder || extent.end - extent.start < holder.end - holder.start) {
            holder = extent;
          }
        }
      }
      if (!holder) {
        return { kind: "outside" };
      }
      return holder.directory === null
        ? { kind: "unknown" }
        : { kind: "directory", path: holder.directory };
    },
  };
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

interface FunctionDefinition {
  kind: "function";
  body: Command;
}

type Command = SimpleCommand | CompoundCommand | FunctionDefinition;

interface Pipeline {
  commands: Command[];
}

interface AndOrList {
  pipelines: Pipeline[];
  background: boolean;
}

interface CommandList {
  items: AndOrList[];
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  owner: SimpleCommand;
}

class Unparsed extends Error {}

// ---------------------------------------------------------------------------
// Lexer and parser

/** Reserved words another command may follow on the same line. */
const COMMAND_PREFIXES = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "time",
]);

/** Characters that end an unquoted word. */
const WORD_BREAKS = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);

const REDIRECTION_OPERATORS = ["<<<", "<<-", "<<", "<&", "<>", "<", ">>", ">&", ">|", ">"];

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

class ScriptParser {
  private pos = 0;
  private readonly pending: PendingHeredoc[] = [];
  /** Open `case` statements, per command list: while one is open, `)` ends a pattern. */
  private readonly caseDepths: number[] = [];

  constructor(private readonly src: string) {}

  parse(): CommandList {
    return this.parseList(null);
  }

  private parseList(closer: ")" | "}" | null): CommandList {
    const items: AndOrList[] = [];
    this.caseDepths.push(0);
    for (;;) {
      this.skipLinebreaks();
      if (this.atEnd()) {
        if (closer !== null) {
          throw new Unparsed();
        }
        break;
      }
      const char = this.src[this.pos];
      if (char === ")") {
        this.pos++;
        if (this.caseDepth() > 0) {
          continue; // the end of a case pattern
        }
        if (closer !== ")") {
          throw new Unparsed();
        }
        break;
      }
      if (closer === "}" && this.atReservedWord("}")) {
        this.pos++;
        break;
      }
      if (char === ";") {
        this.pos++; // an empty case branch's `;;`, or a stray separator
        continue;
      }
      const item = this.parseAndOr();
      items.push(item);
      this.skipBlanks();
      if (this.startsWith("&") && !this.startsWith("&&")) {
        item.background = true;
        this.pos++;
      } else if (this.startsWith(";")) {
        this.pos += this.startsWith(";;&")
          ? 3
          : this.startsWith(";;") || this.startsWith(";&")
            ? 2
            : 1;
      } else if (!this.atEnd() && !["\n", ")", "#"].includes(this.src[this.pos]!)) {
        if (!(closer === "}" && this.atReservedWord("}"))) {
          throw new Unparsed();
        }
      }
    }
    this.caseDepths.pop();
    return { items };
  }

  private parseAndOr(): AndOrList {
    const pipelines = [this.parsePipeline()];
    for (;;) {
      this.skipBlanks();
      if (!this.startsWith("&&") && !this.startsWith("||")) {
        break;
      }
      this.pos += 2;
      this.skipLinebreaks();
      pipelines.push(this.parsePipeline());
    }
    return { pipelines, background: false };
  }

  private parsePipeline(): Pipeline {
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
    return { commands };
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
      const body = this.parseList(")");
      return { kind: "subshell", body, tail: this.parseTail() };
    }
    if (this.atReservedWord("{")) {
      this.pos++;
      const body = this.parseList("}");
      return { kind: "group", body, tail: this.parseTail() };
    }
    if (!this.atWordStart() || this.atRedirection()) {
      return this.parseSimple(null);
    }
    const first = this.readWord();
    if (isReservedWord(first, COMMAND_PREFIXES)) {
      return this.parseCommand();
    }
    if (isReservedWord(first, new Set(["function"]))) {
      this.skipBlanks();
      if (!this.atWordStart()) {
        throw new Unparsed();
      }
      this.readWord();
      return this.parseFunctionBody();
    }
    return this.parseSimple(first);
  }

  /** The words and redirections of a simple command, `first` already read. */
  private parseSimple(first: Word | null): Command {
    const command = this.emptyCommand();
    const addWord = (word: Word) => {
      command.words.push(word);
      command.substitutions.push(...word.substitutions);
      command.end = word.end;
    };
    if (first) {
      command.start = first.start;
      addWord(first);
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
        const substitution = this.parseList(")");
        addWord({ ...bareWord(start, this.pos), expands: true, substitutions: [substitution] });
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
        if (this.startsWith("((") && command.words[0]?.value === "for") {
          this.pos += 2;
          this.skipArithmetic(); // for (( … ))
          command.end = this.pos;
          continue;
        }
        throw new Unparsed();
      }
      if (WORD_BREAKS.has(char)) {
        break;
      }
      addWord(this.readWord());
    }
    this.trackCase(command);
    return command;
  }

  /** The redirections after a compound command's `)` or `}`, and nothing else. */
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

  /** `case` opens a statement in which `)` ends a pattern, and `esac` closes it. */
  private trackCase(command: SimpleCommand): void {
    const first = command.words[0];
    const top = this.caseDepths.length - 1;
    if (first && isReservedWord(first, new Set(["case"]))) {
      this.caseDepths[top]!++;
    } else if (first && isReservedWord(first, new Set(["esac"])) && this.caseDepths[top]! > 0) {
      this.caseDepths[top]!--;
    }
  }

  private caseDepth(): number {
    return this.caseDepths[this.caseDepths.length - 1] ?? 0;
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
    if (!this.atWordStart()) {
      throw new Unparsed();
    }
    const target = this.readWord();
    command.end = target.end;
    command.substitutions.push(...target.substitutions);
    if (operator === "<<" || operator === "<<-") {
      this.pending.push({ delimiter: target.value, stripTabs: operator === "<<-", owner: command });
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
    this.pos++;
    for (;;) {
      if (this.atEnd()) {
        throw new Unparsed();
      }
      const char = this.src[this.pos]!;
      if (char === '"') {
        this.pos++;
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
      word.substitutions.push(this.parseList(")"));
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

  /** A reserved word (`{`, `}`) standing alone at the current position. */
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

// ---------------------------------------------------------------------------
// The directory walk

/** A stretch of the script run in one directory; null is unknown. */
interface Extent {
  start: number;
  end: number;
  directory: string | null;
}

type DirectoryEffect = { kind: "none" } | { kind: "unknown" } | { kind: "cd"; operand: string };

const UNKNOWN_EFFECT_COMMANDS = new Set(["pushd", "popd", "eval", "source", "."]);

function walkList(list: CommandList, directory: string | null, extents: Extent[]): string | null {
  for (const item of list.items) {
    let after = directory;
    for (const pipeline of item.pipelines) {
      after = walkPipeline(pipeline, after, extents);
    }
    // A list sent to the background runs in a subshell.
    directory = item.background && after !== directory ? null : after;
  }
  return directory;
}

/** Each member of a pipeline starts in the directory the pipeline starts in. */
function walkPipeline(
  pipeline: Pipeline,
  directory: string | null,
  extents: Extent[],
): string | null {
  if (pipeline.commands.length === 1) {
    return walkCommand(pipeline.commands[0]!, directory, extents);
  }
  let moved = false;
  for (const command of pipeline.commands) {
    if (walkCommand(command, directory, extents) !== directory) {
      moved = true;
    }
  }
  return moved ? null : directory;
}

function walkCommand(command: Command, directory: string | null, extents: Extent[]): string | null {
  switch (command.kind) {
    case "subshell":
      walkSimple(command.tail, directory, extents);
      walkList(command.body, directory, extents);
      return directory;
    case "group":
      walkSimple(command.tail, directory, extents);
      return walkList(command.body, directory, extents);
    case "function":
      // The body runs whenever the function is called, from wherever.
      walkCommand(command.body, null, extents);
      return null;
    case "simple":
      return walkSimple(command, directory, extents);
  }
}

function walkSimple(
  command: SimpleCommand,
  directory: string | null,
  extents: Extent[],
): string | null {
  for (const substitution of command.substitutions) {
    walkList(substitution, directory, extents);
  }
  if (command.end > command.start) {
    extents.push({ start: command.start, end: command.end, directory });
  }
  for (const [start, end] of command.heredocs) {
    extents.push({ start, end, directory });
  }
  const effect = directoryEffect(command.words);
  switch (effect.kind) {
    case "none":
      return directory;
    case "unknown":
      return null;
    case "cd":
      if (isAbsolute(effect.operand)) {
        return resolve(effect.operand);
      }
      return directory === null ? null : resolve(directory, effect.operand);
  }
}

/** What running a simple command does to the shell's working directory. */
function directoryEffect(words: Word[]): DirectoryEffect {
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

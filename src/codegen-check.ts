/**
 * The offline codegen drift check — pure hashing, no engine, no network, no API key.
 *
 * `client.codegen()` returns stamped artifacts plus a `codegen.lock`; a consumer that
 * commits that tree needs a CI gate over it. This module is that gate — it proves the tree
 * and its lock still agree with each other. Whether the tree still matches what the METHOD
 * resolves to is a second, separate question: answering it needs the engine, so the check
 * cannot, and a caller closes it by comparing {@link CodegenCheckReport.crateFingerprint}
 * against a live `codegen()` response. It never regenerates: regeneration is a **dev action**
 * (it needs the engine), the check is the **CI action** (it needs only hashes), so a
 * template improvement upstream never reddens a consumer's CI.
 *
 * The check is a mirror of pipelex's `run_codegen_check`, and deliberately so: the
 * spec pins the algorithm as "pure hashing, so any client (the CLI, an SDK, a short
 * CI script) implements it identically". A verdict computed here must equal the one
 * `pipelex codegen check` computes over the same bytes — including the drift detail
 * strings, which are kept verbatim so a consumer switching between the CLI and this
 * SDK reads the same report.
 *
 * **Pure by design.** No filesystem, no fetch, no Node builtins: the caller walks its
 * own tree and hands in the text; this module owns the verdict. That is the same
 * split pipelex draws between `build_stamped_projection` (pure) and
 * `write_stamped_projection` (local materialization). Hashing goes through WebCrypto rather
 * than `node:crypto` so this module adds no Node builtin to the barrel's import graph — which
 * is not by itself the same as the barrel being browser-bundleable, since `upload.ts` still
 * names `node:fs/promises` and a browser-targeting bundler must mark `node:*` external.
 *
 * @see {@link runCodegenCheck} for the caller's obligations, which are load-bearing:
 * an incomplete file list or re-encoded text produces a *wrong verdict*, not an error.
 */

import { parse as parseToml } from "smol-toml";

// ── Stamp grammar (mirror of pipelex's `codegen/stamp.py`) ───────────────

const STAMP_BEGIN_MARKER = ">>> pipelex-codegen-stamp >>>";
const STAMP_END_MARKER = "<<< pipelex-codegen-stamp <<<";

/** The line-comment syntax each stampable file type is stamped in. */
const COMMENT_PREFIX_BY_SUFFIX: Record<string, string> = { ".py": "#", ".ts": "//" };

/**
 * The file suffixes codegen stamps — the mirror of pipelex's `STAMPABLE_SUFFIXES`.
 *
 * Exported so a caller's tree walk filters exactly like the check does: a file whose
 * suffix is not here can never be an artifact and can never be an orphan, so it is
 * skipped rather than rejected (this is what lets a consumer park a sidecar such as
 * `sources.json` beside the lock).
 */
export const STAMPABLE_ARTIFACT_SUFFIXES: readonly string[] = Object.freeze(
  Object.keys(COMMENT_PREFIX_BY_SUFFIX).sort(),
);

/** Whether `path` names a file type codegen stamps (and therefore one the check considers). */
export function isStampableArtifactPath(path: string): boolean {
  return Object.hasOwn(COMMENT_PREFIX_BY_SUFFIX, suffixOf(path));
}

/** The last dot-suffix of a path's final component (`""` for a dotfile or a suffixless name). */
function suffixOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex <= 0 ? "" : name.slice(dotIndex);
}

/** The comment prefix for a path's file type, or `undefined` when the type is not stampable. */
function commentPrefixFor(path: string): string | undefined {
  return COMMENT_PREFIX_BY_SUFFIX[suffixOf(path)];
}

/** A stamp parsed back off a file, paired with the body text below it (byte-exact). */
interface ParsedStamp {
  contentHash: string;
  body: string;
}

/**
 * Split a stamped file into its recorded content hash and the body below the stamp,
 * or `null` when no parseable stamp opens the text.
 *
 * Faithful to `parse_stamped` with one deliberate relaxation: the projection axes
 * (`kind` / `target`) must be *present and well-formed*, but their values are not
 * checked against this SDK's vocabulary. pipelex validates them against its own
 * enums, which cannot lag its own emitter; an SDK copy can, and rejecting an
 * unknown-but-valid future `kind` would report every artifact as `hand-edited`.
 * For today's vocabulary the two are identical.
 */
function parseStamped(text: string, commentPrefix: string): ParsedStamp | null {
  const beginLine = `${commentPrefix} ${STAMP_BEGIN_MARKER}`;
  const endLine = `${commentPrefix} ${STAMP_END_MARKER}`;
  if (!text.startsWith(beginLine)) {
    return null;
  }
  const endIndex = text.indexOf(`\n${endLine}\n`);
  if (endIndex === -1) {
    return null;
  }
  const headerRegion = text.slice(beginLine.length + 1, endIndex);
  const body = text.slice(endIndex + endLine.length + 2);

  // Every line the emitter writes inside the fence carries the comment prefix, so anything else in
  // there was injected by hand — and it would otherwise verify as pristine, since the hash covers
  // only the body BELOW the fence. An executable line hiding inside a "DO NOT EDIT" block is not a
  // valid stamp.
  //
  // The wide split is load-bearing here rather than incidental. U+2028 and U+2029 terminate a `//`
  // comment in ECMAScript, so under a `\n`-only split a `.ts` header carrying a raw U+2028 followed
  // by a statement is ONE prefixed line to this gate and TWO lines to the JavaScript engine: the
  // check would report the file current while the engine runs the injected statement. The reference
  // splits on the same set for the same reason (`str.splitlines()` in `parse_stamped`).
  //
  // Nothing legitimate is rejected — the emitter writes `<prefix> <key>: <value>` lines and nothing
  // else, and no caller supplies the two fields that could carry arbitrary text. If either ever
  // does, the line terminators get escaped AT THE EMITTER; this gate stays correct either way,
  // because the emitter never writes a raw one.
  if (pythonSplitLines(headerRegion).some((line) => !line.startsWith(commentPrefix))) {
    return null;
  }

  const fields = parseStampFields(headerRegion, commentPrefix);
  const projection = fields.get("projection");
  if (projection === undefined || !isWellFormedProjection(projection)) {
    return null;
  }
  if (!isJsonObject(fields.get("options") ?? "{}")) {
    return null;
  }
  return { contentHash: fields.get("content_hash") ?? "", body };
}

/**
 * The line boundaries Python's `str.splitlines()` breaks on — deliberately not just `\n`.
 *
 * `normalizeNewlines` has already folded `\r\n` and `\r` away, but `splitlines` also breaks on
 * VT, FF, FS/GS/RS, NEL and the Unicode line/paragraph separators, and those survive it.
 * Splitting on the narrower set diverged in both directions: a header carrying U+2028 inside a
 * field value parsed here as one long value (current) where the reference truncates it
 * (hand-edited), and a header whose lines were JOINED by U+2028 parsed there and not here.
 */
// FS/GS/RS are line boundaries to Python's `splitlines()`, so matching them is the point.
// eslint-disable-next-line no-control-regex
const PYTHON_LINE_BOUNDARY = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/u;

/**
 * Split like Python's `str.splitlines()` — including its trailing-empty rule.
 *
 * `String.prototype.split` keeps a trailing empty segment when the text ends with a boundary, and
 * yields `[""]` for the empty string, where `splitlines` drops the segment and yields `[]`. That
 * difference is invisible to a field loop that skips lines without a `:`, but the prefix gate in
 * `parseStamped` reads EVERY segment — so a header whose last line ends with a line boundary would
 * be rejected here and accepted by the CLI, which is the SDK-is-stricter direction this module
 * exists to avoid.
 */
function pythonSplitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(PYTHON_LINE_BOUNDARY);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The characters `str.isspace()` is true for — what Python's `str.strip()` removes. */
const PYTHON_SPACE_CLASS =
  "\\t\\n\\v\\f\\r\\u001c-\\u001f\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYTHON_STRIP = new RegExp(
  "^[" + PYTHON_SPACE_CLASS + "]+|[" + PYTHON_SPACE_CLASS + "]+" + "$",
  "gu",
);

/**
 * Strip the whitespace Python's `str.strip()` strips — deliberately not JavaScript's `trim()`.
 *
 * The two sets disagree in both directions and each disagreement can flip a verdict. JS strips
 * U+FEFF where Python does not, so a BOM planted before a recorded `content_hash` vanished here
 * and the stamp still verified while the CLI reported `hand-edited`; Python strips U+001C-U+001F
 * and U+0085 where JS does not. Mirroring `str.isspace()` is what keeps a parsed field value
 * byte-identical across the two readers.
 */
function pythonStrip(text: string): string {
  return text.replace(PYTHON_STRIP, "");
}

/** Whether `text` opens with a stamp block in the given comment syntax (the orphan predicate). */
function hasStamp(text: string, commentPrefix: string): boolean {
  return text.startsWith(`${commentPrefix} ${STAMP_BEGIN_MARKER}`);
}

function parseStampFields(headerRegion: string, commentPrefix: string): Map<string, string> {
  const fields = new Map<string, string>();
  // The same split rule as the gate in `parseStamped`, and it has to stay the same one: a narrower
  // split here would rejoin a line the gate had already split, so a field value would swallow the
  // injected text the gate exists to catch.
  for (const rawLine of pythonSplitLines(headerRegion)) {
    // `parseStamped` has already rejected every line without the prefix, so stripping it is
    // unconditional. The tolerant fallback this replaces is what let an uncommented line through.
    const stripped = pythonStrip(rawLine.slice(commentPrefix.length));
    const separatorIndex = stripped.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    fields.set(
      pythonStrip(stripped.slice(0, separatorIndex)),
      pythonStrip(stripped.slice(separatorIndex + 1)),
    );
  }
  return fields;
}

/** `<kind> / <target>` with an optional trailing ` / <pipe_ref>` for a per-pipe projection. */
function isWellFormedProjection(projection: string): boolean {
  const parts = projection.split("/").map((segment) => pythonStrip(segment));
  return parts.length >= 2 && parts[0] !== "" && parts[1] !== "";
}

function isJsonObject(raw: string): boolean {
  let loaded: unknown;
  try {
    loaded = JSON.parse(raw);
  } catch {
    return false;
  }
  return isRecord(loaded);
}

// ── Content hash (mirror of `compute_content_hash`) ──────────────────────

const TEXT_ENCODER = new TextEncoder();

/**
 * The canonical content hash of a generated body: lowercase SHA-256 hex over its UTF-8 bytes.
 *
 * WebCrypto rather than `node:crypto`, so the SDK barrel stays importable from a browser
 * bundle. (`crypto.subtle` is secure-context-only in a browser — https or localhost — which
 * never binds a CI helper but is worth knowing before calling this from a page.)
 */
async function computeContentHash(body: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(body));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── Errors ──────────────────────────────────────────────────────────────

/**
 * A no-verdict condition: the lock is malformed, or a path (in the lock or in the
 * supplied tree) is not a safe canonical artifact path.
 *
 * Deliberately NOT a drift and NOT a `PipelineRequestError`: nothing was requested
 * over the wire, and the check could not produce a verdict at all. A CLI consumer
 * maps a drift report to its exit-1 path and this error to exit 2, per the codegen
 * spec's exit-code policy.
 */
export class CodegenLockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodegenLockError";
  }
}

// ── Public surface ──────────────────────────────────────────────────────

/** The kind of drift found for one artifact — the canonical `DriftCategory` values. */
export type CodegenDriftCategory = "missing" | "modified" | "hand-edited" | "orphan";

/** One drifting artifact: its path (relative to the lock), the category, and a human detail. */
export interface CodegenDrift {
  path: string;
  category: CodegenDriftCategory;
  detail: string;
}

/**
 * One file of the tree being checked.
 *
 * Structurally identical to `GeneratedArtifact`, so a `codegen()` response's
 * `artifacts` array feeds straight in with no mapping.
 */
export interface CodegenTreeFile {
  /** Relative to the lock's directory, forward slashes, canonical — no `./`, no `..`. */
  path: string;
  /**
   * The file's text as read — no BOM stripping, no re-encoding, no reformatting.
   *
   * Line endings are the one thing normalized for you (`\r\n` and lone `\r` become
   * `\n`), mirroring the reference reader — see {@link runCodegenCheck}.
   */
  content: string;
}

/** What {@link runCodegenCheck} needs: the lock's text and the tree it governs. */
export interface CodegenCheckInput {
  /** The `codegen.lock` content, verbatim. A missing lock is the caller's own concern. */
  lockContent: string;
  /** Every file under the lock's directory, recursively — see {@link runCodegenCheck}. */
  files: readonly CodegenTreeFile[];
}

/** The structured verdict of one offline check. */
export interface CodegenCheckReport {
  /** Locked-artifact drifts first (sorted by path), then orphans (sorted by path). */
  drifts: CodegenDrift[];
  /** Whether the tree is in sync — exactly `drifts.length === 0`. */
  isCurrent: boolean;
  /**
   * The lock header's crate fingerprint. Surfaced so a caller can compare a committed
   * tree against a live `codegen()` response's `crate_fingerprint` — a comparison the
   * check itself deliberately never makes, since it would need the engine.
   */
  crateFingerprint: string;
  /** The lock header's pipelex engine version, surfaced for the same reason. */
  engineVersion: string;
}

const MISSING_DETAIL = "Locked artifact is absent on disk.";
const NO_STAMP_DETAIL = "Stamp header is missing or unparseable.";
const STAMP_MISMATCH_DETAIL = "Body was edited below the stamp (stamp hash no longer matches).";
const MODIFIED_DETAIL = "Body no longer matches the locked hash — regenerate.";
const ORPHAN_DETAIL =
  "Stamped generated file not tracked by the lock — stale; remove or regenerate.";

/**
 * Run the offline drift check over one generated tree.
 *
 * The algorithm, per the codegen spec's "Offline check algorithm":
 *
 * 1. For each artifact in the lock, locate it in `files` and recompute the hash of the
 *    body below its stamp; absent is a `missing` drift, a mismatch is a drift.
 * 2. A locked file whose stamp is gone, unparseable, or self-inconsistent is `hand-edited`.
 * 3. A stamped file the lock does not track is an `orphan` (the stale-artifact class a
 *    per-file stamp cannot catch on its own).
 *
 * At most **one** drift is reported per locked path, and `hand-edited` outranks
 * `modified`: a hand edit trips both conditions and is reported once, as the hand edit.
 *
 * **The caller's obligations.** Each one, unmet, yields a *wrong verdict* rather than an
 * error, so none of them can be left implicit:
 *
 * - **Pass the file's text as read, without reformatting it.** The hash is over exact UTF-8
 *   bytes and the stamp parser requires the text to *start with* the begin-marker line, so
 *   re-encoding, inserting a BOM, or running a formatter over an artifact reports
 *   `hand-edited`. Line endings are the one exception: `\r\n` and lone `\r` are normalized
 *   to `\n` first, mirroring the universal-newline translation the reference reader applies
 *   (see `normalizeNewlines`) — so a Windows checkout under `core.autocrlf=true` is NOT a
 *   false hand-edit here, just as it is not one for the CLI. Committing generated artifacts
 *   with a `.gitattributes` entry (e.g. `src/generated/** -text`) is still worth doing for
 *   diff hygiene; it is simply no longer load-bearing for the verdict.
 * - **Walk the whole tree, recursively, from the lock's directory**, and pass paths
 *   relative to it. An incomplete list yields a wrong verdict in either direction: an
 *   omitted *locked* file is reported `missing` though it sits on disk, and an omitted
 *   *orphan* is never seen at all — `isCurrent: true`, a false negative on precisely the
 *   drift class orphan detection exists for. Filter with {@link isStampableArtifactPath}
 *   to walk exactly what the check considers. Pruning vendor/VCS directories and skipping
 *   symlinks is walk policy and stays with the caller (moot for a per-method generated
 *   directory, which holds nothing else).
 * - **Decode the bytes yourself, and decode strictly.** `content` is already a `string`, so
 *   pipelex's "not valid UTF-8 → hand-edited" branch is unreachable here — and note the obvious
 *   reader does not hand it back to you: `readFile(path, "utf8")` substitutes U+FFFD for invalid
 *   bytes and never throws, so a corrupted artifact whose body legitimately contains U+FFFD can
 *   still hash to the locked value and report current. Decode with
 *   `new TextDecoder("utf-8", { fatal: true })` if that matters to you, and report a file you
 *   could not decode yourself — or omit it and accept a `missing` drift for it.
 *
 * What the check deliberately does **not** do: it never compares a stamp's
 * `crate_fingerprint` against the lock's, and it never re-resolves the crate. Both need
 * the engine, which is the whole point of the offline split.
 *
 * @throws {CodegenLockError} for a no-verdict condition — a malformed lock, a lock whose
 * `lock_version` this build cannot read, an unsafe or duplicate artifact path in the lock, or a
 * non-canonical or duplicate path in `files`.
 */
export async function runCodegenCheck(input: CodegenCheckInput): Promise<CodegenCheckReport> {
  const lock = parseLock(normalizeNewlines(input.lockContent));
  const contentByPath = indexTreeFiles(input.files);

  const drifts: CodegenDrift[] = [];
  for (const [path, lockedHash] of sortedEntries(lock.hashByPath)) {
    const content = contentByPath.get(path);
    if (content === undefined) {
      drifts.push({ path, category: "missing", detail: MISSING_DETAIL });
      continue;
    }
    const drift = await checkPresentArtifact(path, content, lockedHash);
    if (drift !== null) {
      drifts.push(drift);
    }
  }
  for (const [path, content] of sortedEntries(contentByPath)) {
    if (lock.hashByPath.has(path)) {
      continue;
    }
    const commentPrefix = commentPrefixFor(path);
    if (commentPrefix !== undefined && hasStamp(content, commentPrefix)) {
      drifts.push({ path, category: "orphan", detail: ORPHAN_DETAIL });
    }
  }

  return {
    drifts,
    isCurrent: drifts.length === 0,
    crateFingerprint: lock.crateFingerprint,
    engineVersion: lock.engineVersion,
  };
}

/**
 * The drift for one locked artifact that is present, or `null` when it is current.
 *
 * The precedence is the point: an early return makes `hand-edited` outrank `modified`,
 * so a hand edit (which trips both the stamp check and the lock check) is reported once.
 */
async function checkPresentArtifact(
  path: string,
  content: string,
  lockedHash: string,
): Promise<CodegenDrift | null> {
  // Never `undefined`: a lock path is suffix-validated when the lock is parsed.
  const commentPrefix = commentPrefixFor(path);
  const parsed = commentPrefix === undefined ? null : parseStamped(content, commentPrefix);
  if (parsed === null) {
    return { path, category: "hand-edited", detail: NO_STAMP_DETAIL };
  }
  const bodyHash = await computeContentHash(parsed.body);
  if (parsed.contentHash !== bodyHash) {
    return { path, category: "hand-edited", detail: STAMP_MISMATCH_DETAIL };
  }
  if (bodyHash !== lockedHash) {
    return { path, category: "modified", detail: MODIFIED_DETAIL };
  }
  return null;
}

/** Index the supplied tree by path, rejecting unsafe and duplicate paths. */
function indexTreeFiles(files: readonly CodegenTreeFile[]): Map<string, string> {
  const contentByPath = new Map<string, string>();
  for (const file of files) {
    // The suffix rule is NOT applied here: a non-stampable file (a `sources.json`
    // sidecar, say) is legitimately present in the tree and is simply skipped.
    validateCanonicalPath(file.path);
    if (contentByPath.has(file.path)) {
      raisePathError(file.path, "Duplicate artifact path");
    }
    contentByPath.set(file.path, normalizeNewlines(file.content));
  }
  return contentByPath;
}

// ── Lock parsing (mirror of pipelex's `codegen/lock.py`) ─────────────────

interface ParsedCodegenLock {
  crateFingerprint: string;
  engineVersion: string;
  hashByPath: Map<string, string>;
}

/**
 * The lock format version this build reads — mirrors the reference's `CODEGEN_LOCK_VERSION`.
 *
 * Any change to the lock's key set, or to the meaning of an existing key, bumps it on both sides.
 */
const CODEGEN_LOCK_VERSION = 1;

const LOCK_KEYS = new Set(["lock_version", "crate_fingerprint", "engine_version", "artifacts"]);
const LOCK_ARTIFACT_KEYS = new Set(["path", "content_hash"]);

/**
 * Parse and validate a `codegen.lock`.
 *
 * Strict on shape, mirroring the reference model's `extra="forbid"`: an unknown key is
 * a malformed lock, not a field to ignore. The lock is a Pipelex-owned artifact written
 * by a versioned engine, so an unrecognized shape means the two disagree about what the
 * hashes cover — better a loud no-verdict than a confident wrong one.
 */
function parseLock(lockContent: string): ParsedCodegenLock {
  let data: unknown;
  try {
    data = parseToml(lockContent);
  } catch (err) {
    throw new CodegenLockError(`Malformed codegen lock: ${describeError(err)}`, { cause: err });
  }
  if (!isRecord(data)) {
    throw new CodegenLockError("Malformed codegen lock: the top level is not a TOML table.");
  }
  rejectUnknownLockVersion(data);
  rejectUnknownKeys(data, LOCK_KEYS, "codegen lock");

  const crateFingerprint = readString(data, "crate_fingerprint", "codegen lock");
  const engineVersion = readString(data, "engine_version", "codegen lock");

  const rawArtifacts = data["artifacts"] ?? [];
  if (!Array.isArray(rawArtifacts)) {
    throw new CodegenLockError("Malformed codegen lock: 'artifacts' must be an array of tables.");
  }
  const hashByPath = new Map<string, string>();
  for (const rawArtifact of rawArtifacts) {
    if (!isRecord(rawArtifact)) {
      throw new CodegenLockError("Malformed codegen lock: each artifact must be a TOML table.");
    }
    rejectUnknownKeys(rawArtifact, LOCK_ARTIFACT_KEYS, "codegen lock artifact");
    const path = readString(rawArtifact, "path", "codegen lock artifact");
    const contentHash = readString(rawArtifact, "content_hash", "codegen lock artifact");
    validateArtifactPath(path);
    if (hashByPath.has(path)) {
      raisePathError(path, "Duplicate artifact path");
    }
    hashByPath.set(path, contentHash);
  }
  return { crateFingerprint, engineVersion, hashByPath };
}

/**
 * Refuse a lock whose format version this build cannot read, BEFORE its key set is validated.
 *
 * The ordering is the whole point of the field, and the easiest thing to get wrong. Run the other
 * way round, `rejectUnknownKeys` rejects a future lock as a shape error over a key the writer was
 * entitled to add — so the reader reports an opaque complaint about that key instead of naming the
 * version and saying which side to upgrade, which is precisely the unactionable no-verdict the
 * field was introduced to remove.
 */
function rejectUnknownLockVersion(data: Record<string, unknown>): void {
  // No key at all means the lock was written before the field existed, which is version 1 by
  // definition — nothing on disk needs migrating. It still faces the comparison below rather than
  // returning early, or the day the constant moves every legacy lock would skip the gate and be
  // validated against a schema it was never written for.
  const rawVersion = data["lock_version"] ?? 1;
  // `typeof` excludes a TOML boolean, which is the JavaScript shape of the reference's
  // `bool`-is-an-`int` guard (there, `True == 1` would have read as version 1).
  //
  // A TOML float is NOT excluded, and cannot be: smol-toml decodes `1.0` to the same `1` as the
  // integer, so this reader accepts a spelling the reference calls malformed. No emitter writes it,
  // and the divergence is a no-verdict there against version 1 here.
  const isVersionNumber = typeof rawVersion === "number" && Number.isInteger(rawVersion);
  if (isVersionNumber && rawVersion === CODEGEN_LOCK_VERSION) {
    return;
  }
  const reason =
    isVersionNumber && rawVersion > CODEGEN_LOCK_VERSION
      ? `it declares lock_version ${rawVersion} — upgrade @pipelex/sdk to a build that reads it`
      : `lock_version ${describeLockVersion(rawVersion)} is not a known codegen lock format version`;
  throw new CodegenLockError(
    `Unsupported codegen lock version: this build reads lock_version ${CODEGEN_LOCK_VERSION}, but ${reason}.`,
  );
}

/** Python's `!r` for the values TOML can put here, so both readers name a bad version the same way. */
function describeLockVersion(rawVersion: unknown): string {
  return typeof rawVersion === "string" ? `'${rawVersion}'` : String(rawVersion);
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  what: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CodegenLockError(`Malformed ${what}: unexpected key '${key}'.`);
    }
  }
}

function readString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new CodegenLockError(`Malformed ${what}: '${key}' must be a string.`);
  }
  return value;
}

// ── Path validation (mirror of `validate_artifact_path` / `validate_artifact_paths`) ──

const CONTROL_CHARACTER = /\p{C}/u;
/**
 * A Windows drive prefix as `PureWindowsPath` sees one: ANY single leading character followed
 * by `:`, not only an ASCII letter. `1:models.py` and `_:models.py` are drives to the reference
 * and were accepted here, making this validator the permissive side of the pair.
 *
 * The `s` flag is load-bearing, not decoration: without it `.` skips the line terminators, and
 * U+2028 / U+2029 are separators rather than `\p{C}` controls, so they sail past the control
 * check above and would be the last two drive prefixes this side still accepted. (`\n` and `\r`
 * are the other characters `.` excludes, and those the control check already rejects.)
 */
const WINDOWS_DRIVE = /^.:/su;

/**
 * Validate one canonical relative path: the safety rules, without the suffix rule.
 *
 * These are the rules that keep a path from meaning something other than what it spells —
 * an absolute path, a drive prefix, a `..` escape, a backslash a Windows caller would
 * resolve differently, a control character. They apply to every path the check sees.
 */
function validateCanonicalPath(path: string): void {
  if (path === "") {
    raisePathError(path, "path is empty");
  }
  if (path.includes("\\")) {
    raisePathError(path, "backslashes are not allowed; use forward slashes");
  }
  if (CONTROL_CHARACTER.test(path)) {
    raisePathError(path, "control characters are not allowed");
  }
  if (path.startsWith("/") || WINDOWS_DRIVE.test(path)) {
    raisePathError(path, "absolute paths and drive prefixes are not allowed");
  }
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    raisePathError(path, "empty, '.', and '..' path components are not allowed");
  }
}

/** Validate one path the lock tracks: canonical, and of a suffix codegen actually stamps. */
function validateArtifactPath(path: string): void {
  validateCanonicalPath(path);
  if (!isStampableArtifactPath(path)) {
    const expected = STAMPABLE_ARTIFACT_SUFFIXES.join(", ");
    raisePathError(path, `unsupported artifact suffix (expected one of: ${expected})`);
  }
}

function raisePathError(path: string, reason: string): never {
  throw new CodegenLockError(`Unsafe codegen artifact path '${path}': ${reason}.`);
}

// ── Small helpers ───────────────────────────────────────────────────────

/**
 * Translate `\r\n` and lone `\r` to `\n`, the way the reference implementation's reader does.
 *
 * NOT a convenience: it is what keeps this check and `pipelex codegen check` in agreement.
 * pipelex reads artifacts with `Path.read_text()`, whose default `newline=None` applies
 * Python universal-newline translation — so the reference check never sees a `\r`, and its
 * verdict is over line-ending-normalized text rather than raw bytes. The same default on the
 * write side means pipelex running on Windows *emits* CRLF artifacts whose locked hashes were
 * computed over LF. Hashing raw bytes here would therefore report every artifact of a
 * Windows-generated (or `core.autocrlf=true`-checked-out) tree as `hand-edited`, while the CLI
 * called it current — a false positive on the exact tree a consumer's CI is gating.
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Entries in ascending path order — the deterministic order drifts are reported in. */
function sortedEntries(map: Map<string, string>): [string, string][] {
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

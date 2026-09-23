/**
 * Client identification: the `User-Agent` this SDK sends to the Pipelex API.
 *
 * Implements the workspace contract `docs/specs/client-identification.md`. The
 * value is a sequence of RFC 9110 product tokens, outermost first:
 *
 *   [<appInfo>] pipelex-sdk-js/<SDK_VERSION> [<runtime>/<version> (<os>; <arch>)]
 *
 * The integrator's `appInfo` comes first, the SDK next, the runtime last. The SDK
 * calls `fetch` itself, so no other library appears on the transport path. In a
 * browser no header is produced at all: browsers either ignore it or turn it into
 * a CORS preflight the API refuses.
 *
 * The header is self-declared and unauthenticated — analytics and diagnostics
 * only, never an authorization signal.
 */

import { SDK_VERSION } from "./version.js";

/** The SDK's own product token name, from the spec's token registry. */
export const SDK_TOKEN_NAME = "pipelex-sdk-js";

/** The spec's ceiling on the whole header value. */
export const MAX_USER_AGENT_LENGTH = 512;

/**
 * The integrator's identity, placed before the SDK's own token (Stripe-style).
 *
 * Renders as `name/version (<details>; +url)`; the `/version` and the comment are
 * dropped when empty. An invalid field is refused at construction with a
 * `TypeError` — it is never silently dropped or rewritten.
 */
export interface AppInfo {
  /** An RFC 9110 `token`, lowercase kebab-case by convention, e.g. `acme-invoicer`. */
  name: string;
  /** An RFC 9110 `token`, e.g. `1.4.0`. */
  version?: string;
  /** A URL, rendered in the comment as `+url`. */
  url?: string;
  /** Comment parameters, each a `token` or `token=value`, rendered before `+url`. */
  details?: string[];
}

/** The runtime the SDK is running on, as far as the header is concerned. */
export type RuntimeInfo =
  | { kind: "browser" }
  | { kind: "server"; name?: string; version?: string; os?: string; arch?: string };

// RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
// "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// `value = token / ( name "/" version )`.
const DETAIL_VALUE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+)?$/;
// A URL inside a comment: visible ASCII, no whitespace, and none of the characters
// that would close the comment or split it into another parameter.
const COMMENT_URL = /^[!-~]+$/;
const COMMENT_BREAKERS = /[()\\;]/;

function isToken(value: string): boolean {
  return TOKEN.test(value);
}

function isDetail(detail: string): boolean {
  const eq = detail.indexOf("=");
  if (eq === -1) return isToken(detail);
  return isToken(detail.slice(0, eq)) && DETAIL_VALUE.test(detail.slice(eq + 1));
}

/**
 * Refuse an `appInfo` the spec's grammar does not admit, with a `TypeError` naming
 * the offending field. Empty `version`, `url` and `details` are treated as absent.
 */
export function validateAppInfo(appInfo: AppInfo): void {
  if (typeof appInfo !== "object" || appInfo === null) {
    throw new TypeError("appInfo must be an object with at least a `name`.");
  }
  if (typeof appInfo.name !== "string" || !isToken(appInfo.name)) {
    throw new TypeError(
      `appInfo.name ${JSON.stringify(appInfo.name)} is not an RFC 9110 token ` +
        "(letters, digits and !#$%&'*+-.^_`|~ only, non-empty).",
    );
  }
  if (appInfo.version !== undefined && appInfo.version !== "") {
    if (typeof appInfo.version !== "string" || !isToken(appInfo.version)) {
      throw new TypeError(
        `appInfo.version ${JSON.stringify(appInfo.version)} is not an RFC 9110 token.`,
      );
    }
  }
  if (appInfo.url !== undefined && appInfo.url !== "") {
    if (
      typeof appInfo.url !== "string" ||
      !COMMENT_URL.test(appInfo.url) ||
      COMMENT_BREAKERS.test(appInfo.url)
    ) {
      throw new TypeError(
        `appInfo.url ${JSON.stringify(appInfo.url)} cannot sit in a User-Agent comment ` +
          "(visible ASCII only, no whitespace, parentheses, backslash or semicolon).",
      );
    }
  }
  if (appInfo.details !== undefined) {
    if (!Array.isArray(appInfo.details)) {
      throw new TypeError("appInfo.details must be an array of strings.");
    }
    for (const detail of appInfo.details) {
      if (typeof detail !== "string" || !isDetail(detail)) {
        throw new TypeError(
          `appInfo.details entry ${JSON.stringify(detail)} is neither a token nor token=value.`,
        );
      }
    }
  }
}

/** Render a validated `appInfo` as `name/version (<details>; +url)`, omitting empty parts. */
export function renderAppInfo(appInfo: AppInfo): string {
  let product = appInfo.name;
  if (appInfo.version) product += `/${appInfo.version}`;
  const params = [...(appInfo.details ?? [])];
  if (appInfo.url) params.push(`+${appInfo.url}`);
  return params.length > 0 ? `${product} (${params.join("; ")})` : product;
}

interface DenoLike {
  version?: { deno?: string };
  build?: { os?: string; arch?: string };
}

interface ProcessLike {
  versions?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
}

/**
 * Read the runtime from the globals. A browser (a window with a document, or a
 * web worker) is reported as such so the caller sets no header. Deno is checked
 * before Bun and Node because it also exposes a Node-compatible `process`.
 */
export function detectRuntime(scope: Record<string, unknown> = globalThis): RuntimeInfo {
  const win = scope["window"] as { document?: unknown } | undefined;
  if (
    (win !== undefined && win !== null && win.document !== undefined) ||
    typeof scope["importScripts"] === "function"
  ) {
    return { kind: "browser" };
  }
  const deno = scope["Deno"] as DenoLike | undefined;
  if (deno?.version?.deno) {
    return {
      kind: "server",
      name: "deno",
      version: deno.version.deno,
      os: deno.build?.os,
      arch: deno.build?.arch,
    };
  }
  const proc = scope["process"] as ProcessLike | undefined;
  const bun = proc?.versions?.["bun"];
  if (bun) {
    return { kind: "server", name: "bun", version: bun, os: proc.platform, arch: proc.arch };
  }
  const node = proc?.versions?.["node"];
  if (node) {
    return { kind: "server", name: "node", version: node, os: proc.platform, arch: proc.arch };
  }
  return { kind: "server" };
}

function renderRuntime(runtime: Extract<RuntimeInfo, { kind: "server" }>): string | undefined {
  if (!runtime.name || !runtime.version || !isToken(runtime.version)) return undefined;
  const token = `${runtime.name}/${runtime.version}`;
  const platform = [runtime.os, runtime.arch].filter(
    (part): part is string => typeof part === "string" && isToken(part),
  );
  return platform.length > 0 ? `${token} (${platform.join("; ")})` : token;
}

/**
 * Build the full `User-Agent` value, or `undefined` in a browser, where no header
 * may be set. Validates `appInfo` first and refuses (with a `RangeError`) a value
 * that would exceed the spec's 512-character ceiling rather than truncating it.
 */
export function buildUserAgent(
  appInfo?: AppInfo,
  runtime: RuntimeInfo = detectRuntime(),
): string | undefined {
  if (appInfo !== undefined) validateAppInfo(appInfo);
  const parts: string[] = [];
  if (appInfo !== undefined) parts.push(renderAppInfo(appInfo));
  parts.push(`${SDK_TOKEN_NAME}/${SDK_VERSION}`);
  if (runtime.kind === "server") {
    const runtimePart = renderRuntime(runtime);
    if (runtimePart) parts.push(runtimePart);
  }
  const value = parts.join(" ");
  // Checked before the browser return, so an `appInfo` refused on a server is refused
  // in a browser too: the refusal is a property of the `appInfo`, not of the runtime.
  if (value.length > MAX_USER_AGENT_LENGTH) {
    throw new RangeError(
      `The User-Agent built from appInfo is ${value.length} characters; the ceiling is ` +
        `${MAX_USER_AGENT_LENGTH}. Shorten appInfo.details or appInfo.url.`,
    );
  }
  if (runtime.kind === "browser") return undefined;
  return value;
}

/**
 * Stamp-aware tree mutators, shared by the unit and E2E codegen-check suites.
 *
 * They live in one module rather than in each suite because the distinction they
 * encode is subtle and load-bearing in both: {@link handEdit} leaves the stamp
 * behind still claiming the old body (which reports `hand-edited`), while
 * {@link regenerate} rewrites the stamp to agree with the new body, leaving only
 * the lock stale (the one and only way to reach `modified`). Two private copies
 * could drift, and the drifted copy would quietly stop exercising its category
 * while still passing.
 */

import { createHash } from "node:crypto";

export const STAMP_BEGIN = ">>> pipelex-codegen-stamp >>>";
export const STAMP_END = "<<< pipelex-codegen-stamp <<<";

/**
 * The canonical content hash — lowercase SHA-256 hex over the body's UTF-8 bytes.
 *
 * Computed here through `node:crypto`, which is deliberately *not* what the module
 * under test uses (it hashes through WebCrypto so the barrel stays client-safe), so
 * these suites cross-check one implementation against another.
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The stamp block (through its end-marker line) and the body it protects. */
export function splitStamp(
  content: string,
  commentPrefix = "//",
): { header: string; body: string } {
  const endLine = `${commentPrefix} ${STAMP_END}\n`;
  const cut = content.indexOf(endLine) + endLine.length;
  return { header: content.slice(0, cut), body: content.slice(cut) };
}

/** A hand edit: the body changes, the stamp is left behind saying otherwise. */
export function handEdit(content: string, newBody: string, commentPrefix = "//"): string {
  return splitStamp(content, commentPrefix).header + newBody;
}

/**
 * A legitimate regeneration against a NEWER crate: body and stamp agree with each
 * other, and only the lock is stale. This is the only way to reach `modified` — a
 * plain body edit trips the stamp check first and reports `hand-edited`.
 */
export function regenerate(content: string, newBody: string, commentPrefix = "//"): string {
  const { header } = splitStamp(content, commentPrefix);
  return header.replace(/content_hash: [0-9a-f]+/, `content_hash: ${sha256(newBody)}`) + newBody;
}

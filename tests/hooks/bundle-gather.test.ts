/**
 * Bundle-gathering tests: the multi-file set sent to `/v1/validate` around an
 * edited `.mthds` file — recursive parent-dir scan, exclusions, deterministic
 * order (edited file first), and the caps whose overflow must read as
 * `unavailable` upstream (an under-supplied bundle risks a false block).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherBundle } from "../../src/hooks/bundle-gather.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hook-gather-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (relPath: string, content = `domain = "d"\n`): string => {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};

describe("gatherBundle", () => {
  it("returns the edited file first, then siblings and nested files sorted", () => {
    const edited = put("b_edited.mthds", `domain = "edited"\n`);
    put("a_sibling.mthds");
    put("nested/deep.mthds");

    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.uri)).toEqual([
      "b_edited.mthds",
      "a_sibling.mthds",
      join("nested", "deep.mthds"),
    ]);
    expect(result.files[0]?.content).toBe(`domain = "edited"\n`);
  });

  it("skips dot-directories and excluded dirs", () => {
    const edited = put("main.mthds");
    put(".git/hidden.mthds");
    put("node_modules/pkg/dep.mthds");
    put("__pycache__/cache.mthds");
    put("results/out.mthds");

    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.uri)).toEqual(["main.mthds"]);
  });

  it("ignores non-mthds files", () => {
    const edited = put("main.mthds");
    writeFileSync(join(root, "README.md"), "# nope");

    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
  });

  it("overflows on too many files", () => {
    const edited = put("main.mthds");
    for (let i = 0; i < 3; i++) {
      put(`extra_${i}.mthds`);
    }
    const result = gatherBundle(edited, { maxFiles: 3, maxTotalBytes: 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("overflows on too many bytes", () => {
    const edited = put("main.mthds", "x".repeat(2048));
    const result = gatherBundle(edited, { maxFiles: 50, maxTotalBytes: 1024 });
    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("reports unreadable when the edited file vanished", () => {
    const edited = put("main.mthds");
    rmSync(edited);
    const result = gatherBundle(edited);
    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });
});

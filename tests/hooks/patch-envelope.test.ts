/**
 * The patch envelope reader: sections with their offsets and added lines, and
 * the `.mthds` files that survive the patch once its sections are applied in
 * order.
 */

import { describe, expect, it } from "vitest";
import { patchTargets, readPatchSections } from "../../src/hooks/patch-envelope.js";

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");

describe("readPatchSections", () => {
  it("reads each header kind with its offset and added lines", () => {
    const text = patch(
      "*** Add File: new.mthds",
      '+domain = "demo"',
      "+",
      "*** Update File: old.mthds",
      "@@ [pipe.x]",
      " context",
      "-removed",
      "+added",
      "*** Delete File: gone.mthds",
    );
    const sections = readPatchSections(text);
    expect(sections).toEqual([
      {
        kind: "add",
        path: "new.mthds",
        moveTo: null,
        offset: text.indexOf("*** Add File"),
        addedLines: ['domain = "demo"', ""],
      },
      {
        kind: "update",
        path: "old.mthds",
        moveTo: null,
        offset: text.indexOf("*** Update File"),
        addedLines: ["added"],
      },
      {
        kind: "delete",
        path: "gone.mthds",
        moveTo: null,
        offset: text.indexOf("*** Delete File"),
        addedLines: [],
      },
    ]);
  });

  it("attaches a Move to header to the update section it belongs to", () => {
    const sections = readPatchSections(
      patch("*** Update File: a.mthds", "*** Move to: sub/b.mthds", "@@", "+x"),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ kind: "update", path: "a.mthds", moveTo: "sub/b.mthds" });
    expect(sections[0]!.addedLines).toEqual(["x"]);
  });

  it("ignores a Move to header outside an update section", () => {
    const sections = readPatchSections(
      patch("*** Add File: a.mthds", "*** Move to: b.mthds", "+x"),
    );
    expect(sections).toEqual([
      expect.objectContaining({ kind: "add", path: "a.mthds", moveTo: null, addedLines: ["x"] }),
    ]);
  });

  it("trims the path and tolerates a missing space after the colon", () => {
    const sections = readPatchSections("*** Update File:  spaced.mthds  \r\n+x\r\n");
    expect(sections[0]).toMatchObject({ path: "spaced.mthds", addedLines: ["x"] });
  });

  it("ends a section at End Patch, so later script lines are not its content", () => {
    const text = [
      "apply_patch <<'EOF'",
      patch("*** Update File: a.mthds", "+kept"),
      "EOF",
      "+not part of the patch",
    ].join("\n");
    expect(readPatchSections(text)[0]!.addedLines).toEqual(["kept"]);
  });

  it("reads several envelopes in one text", () => {
    const text = patch("*** Update File: a.mthds", "+a") + patch("*** Add File: b.mthds", "+b");
    expect(readPatchSections(text).map((section) => section.path)).toEqual(["a.mthds", "b.mthds"]);
  });

  it("only reads headers at the start of a line", () => {
    expect(readPatchSections("echo '  *** Update File: a.mthds'\n")).toEqual([]);
  });

  it("skips a header with no path", () => {
    expect(readPatchSections(patch("*** Update File:", "+x"))).toEqual([]);
  });

  it("returns nothing for text with no envelope", () => {
    expect(readPatchSections("ls -la\necho done\n")).toEqual([]);
    expect(readPatchSections("")).toEqual([]);
  });
});

describe("patchTargets", () => {
  const targetsOf = (text: string) =>
    patchTargets(readPatchSections(text)).map((file) => file.path);

  it("keeps added and updated .mthds files, and nothing else", () => {
    expect(
      targetsOf(
        patch(
          "*** Add File: a.mthds",
          "+a",
          "*** Update File: b.mthds",
          "+b",
          "*** Update File: code.py",
          "+c",
        ),
      ),
    ).toEqual(["a.mthds", "b.mthds"]);
  });

  it("replaces a moved file by its destination", () => {
    expect(targetsOf(patch("*** Update File: a.mthds", "*** Move to: c.mthds", "+x"))).toEqual([
      "c.mthds",
    ]);
  });

  it("keeps a .mthds destination of a file with another extension", () => {
    expect(targetsOf(patch("*** Update File: a.txt", "*** Move to: a.mthds"))).toEqual(["a.mthds"]);
  });

  it("drops a .mthds file moved to another extension", () => {
    expect(targetsOf(patch("*** Update File: a.mthds", "*** Move to: a.txt"))).toEqual([]);
  });

  it("drops a file the patch deletes, and keeps one it adds back", () => {
    expect(targetsOf(patch("*** Update File: a.mthds", "+x", "*** Delete File: a.mthds"))).toEqual(
      [],
    );
    expect(targetsOf(patch("*** Delete File: a.mthds", "*** Add File: a.mthds", "+x"))).toEqual([
      "a.mthds",
    ]);
  });

  it("uses the last section's added lines for a file named twice", () => {
    const files = patchTargets(
      readPatchSections(
        patch("*** Update File: a.mthds", "+first", "*** Update File: a.mthds", "+second"),
      ),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.section.addedLines).toEqual(["second"]);
  });

  it("keeps a section that adds no line", () => {
    const files = patchTargets(readPatchSections(patch("*** Update File: a.mthds", "@@", "-x")));
    expect(files.map((file) => file.section.addedLines)).toEqual([[]]);
  });

  it("compares paths by the caller's key", () => {
    const sections = readPatchSections(
      patch("*** Update File: a.mthds", "+x", "*** Delete File: ./a.mthds"),
    );
    expect(patchTargets(sections).map((file) => file.path)).toEqual(["a.mthds"]);
    expect(patchTargets(sections, (path) => path.replace(/^\.\//, ""))).toEqual([]);
  });
});

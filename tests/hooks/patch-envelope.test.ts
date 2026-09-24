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
        envelope: 1,
        addedLines: ['domain = "demo"', ""],
      },
      {
        kind: "update",
        path: "old.mthds",
        moveTo: null,
        offset: text.indexOf("*** Update File"),
        envelope: 1,
        addedLines: ["added"],
      },
      {
        kind: "delete",
        path: "gone.mthds",
        moveTo: null,
        offset: text.indexOf("*** Delete File"),
        envelope: 1,
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

  it("reads several envelopes in one text, numbering each", () => {
    const text = patch("*** Update File: a.mthds", "+a") + patch("*** Add File: b.mthds", "+b");
    expect(readPatchSections(text).map(({ path, envelope }) => [path, envelope])).toEqual([
      ["a.mthds", 1],
      ["b.mthds", 3],
    ]);
  });

  it("ends an envelope on its End Patch line when its Begin Patch does not start a line", () => {
    const argument = (...lines: string[]) =>
      `apply_patch '*** Begin Patch\n${lines.join("\n")}\n*** End Patch'\n`;
    const text = argument("*** Add File: a.mthds", "+x") + argument("*** Delete File: a.mthds");
    const envelopes = readPatchSections(text).map((section) => section.envelope);
    expect(envelopes[0]).not.toBe(envelopes[1]);
    expect(patchTargets(readPatchSections(text))).toMatchObject([
      { path: "a.mthds", removedByPatch: true },
    ]);
  });

  it("gives sections before any Begin Patch line an envelope of their own", () => {
    const text = "*** Update File: a.mthds\n+a\n" + patch("*** Update File: b.mthds", "+b");
    expect(readPatchSections(text).map((section) => section.envelope)).toEqual([0, 1]);
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
    expect(files[0]!.sections.map((section) => section.addedLines)).toEqual([["second"]]);
  });

  it("keeps a section that adds no line", () => {
    const files = patchTargets(readPatchSections(patch("*** Update File: a.mthds", "@@", "-x")));
    expect(files.map((file) => file.sections[0]!.addedLines)).toEqual([[]]);
  });

  it("flags a file some section removes, even when a later one adds it back", () => {
    const [kept] = patchTargets(
      readPatchSections(patch("*** Delete File: a.mthds", "*** Add File: a.mthds", "+x")),
    );
    expect(kept).toMatchObject({ path: "a.mthds", removedByPatch: true });
    const [edited] = patchTargets(readPatchSections(patch("*** Update File: a.mthds", "+x")));
    expect(edited).toMatchObject({ path: "a.mthds", removedByPatch: false });
  });

  it("keeps a file one envelope edits and another deletes, whatever their order", () => {
    const edit = patch("*** Update File: a.mthds", "+x");
    const remove = patch("*** Delete File: a.mthds");
    for (const text of [edit + remove, remove + edit]) {
      const files = patchTargets(readPatchSections(text));
      expect(files).toMatchObject([{ path: "a.mthds", removedByPatch: true }]);
      expect(files[0]!.sections.map((section) => section.addedLines)).toEqual([["x"]]);
    }
  });

  it("keeps the added lines of every envelope that writes a file", () => {
    const text =
      patch("*** Update File: a.mthds", "+first") + patch("*** Update File: a.mthds", "+second");
    const files = patchTargets(readPatchSections(text));
    expect(files.map((file) => file.sections.map((section) => section.addedLines))).toEqual([
      [["first"], ["second"]],
    ]);
  });

  it("keeps a moved file's source when another envelope writes it", () => {
    const text =
      patch("*** Update File: a.mthds", "*** Move to: b.mthds", "+x") +
      patch("*** Add File: a.mthds", "+y");
    expect(targetsOf(text)).toEqual(["b.mthds", "a.mthds"]);
  });

  it("compares paths by the caller's key", () => {
    const sections = readPatchSections(
      patch("*** Update File: a.mthds", "+x", "*** Delete File: ./a.mthds"),
    );
    expect(patchTargets(sections).map((file) => file.path)).toEqual(["a.mthds"]);
    expect(patchTargets(sections, (path) => path.replace(/^\.\//, ""))).toEqual([]);
  });
});

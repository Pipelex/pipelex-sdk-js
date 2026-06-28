import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("SDK_VERSION", () => {
  it("is exported as a semver string", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the version in package.json", () => {
    // The exported runtime constant must not drift from the published package
    // version — a stale value misreports the SDK to consumers doing diagnostics
    // or compatibility checks. The /release skill bumps both together.
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/index.js";

describe("SDK_VERSION", () => {
  it("is exported as a semver string", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

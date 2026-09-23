import { describe, expect, it } from "vitest";
import {
  MAX_USER_AGENT_LENGTH,
  buildUserAgent,
  detectRuntime,
  renderAppInfo,
  validateAppInfo,
  type AppInfo,
  type RuntimeInfo,
} from "../src/user-agent.js";
import { SDK_VERSION } from "../src/version.js";

const NODE: RuntimeInfo = {
  kind: "server",
  name: "node",
  version: "22.4.0",
  os: "darwin",
  arch: "arm64",
};

describe("renderAppInfo", () => {
  it("renders the name alone", () => {
    expect(renderAppInfo({ name: "acme-invoicer" })).toBe("acme-invoicer");
  });

  it("renders name/version", () => {
    expect(renderAppInfo({ name: "acme-invoicer", version: "1.4.0" })).toBe("acme-invoicer/1.4.0");
  });

  it("renders details then +url in one comment", () => {
    expect(
      renderAppInfo({
        name: "pipelex-mcp",
        version: "0.17.0",
        details: ["workshop", "host=claude-code/2.1.4"],
        url: "https://acme.example/app",
      }),
    ).toBe("pipelex-mcp/0.17.0 (workshop; host=claude-code/2.1.4; +https://acme.example/app)");
  });

  it("renders a url alone as the comment", () => {
    expect(renderAppInfo({ name: "acme", url: "https://acme.example" })).toBe(
      "acme (+https://acme.example)",
    );
  });

  it("drops empty version, url and details", () => {
    expect(renderAppInfo({ name: "acme", version: "", url: "", details: [] })).toBe("acme");
  });
});

describe("validateAppInfo", () => {
  it("accepts every field in the grammar", () => {
    expect(() =>
      validateAppInfo({
        name: "acme-invoicer",
        version: "0.2.16-rc.01",
        url: "https://acme.example/x?y=1",
        details: ["console", "host=openai", "host=claude-code/2.1.4"],
      }),
    ).not.toThrow();
  });

  const refusals: [string, AppInfo][] = [
    ["an empty name", { name: "" }],
    ["a name with a space", { name: "acme invoicer" }],
    ["a name with a slash", { name: "acme/1.0" }],
    ["a name with a non-ASCII character", { name: "acmé" }],
    ["a version with a space", { name: "acme", version: "1.0 beta" }],
    ["a version with parentheses", { name: "acme", version: "(1.0)" }],
    ["a url with whitespace", { name: "acme", url: "https://acme.example/a b" }],
    ["a url with a semicolon", { name: "acme", url: "https://acme.example/;x" }],
    ["a url with a parenthesis", { name: "acme", url: "https://acme.example/)" }],
    ["a detail with a space", { name: "acme", details: ["two words"] }],
    ["a detail with a semicolon", { name: "acme", details: ["a;b"] }],
    ["a detail with an empty key", { name: "acme", details: ["=x"] }],
    ["a detail with an empty value", { name: "acme", details: ["host="] }],
    ["a detail whose value has two slashes", { name: "acme", details: ["host=a/b/c"] }],
  ];
  for (const [label, appInfo] of refusals) {
    it(`refuses ${label} with a TypeError`, () => {
      expect(() => validateAppInfo(appInfo)).toThrow(TypeError);
    });
  }

  it("refuses a non-object and non-string fields with a TypeError", () => {
    expect(() => validateAppInfo(null as unknown as AppInfo)).toThrow(TypeError);
    expect(() => validateAppInfo({ name: 42 } as unknown as AppInfo)).toThrow(TypeError);
    expect(() => validateAppInfo({ name: "a", version: 1 } as unknown as AppInfo)).toThrow(
      TypeError,
    );
    expect(() => validateAppInfo({ name: "a", url: 1 } as unknown as AppInfo)).toThrow(TypeError);
    expect(() => validateAppInfo({ name: "a", details: "x" } as unknown as AppInfo)).toThrow(
      TypeError,
    );
    expect(() => validateAppInfo({ name: "a", details: [1] } as unknown as AppInfo)).toThrow(
      TypeError,
    );
  });
});

describe("buildUserAgent", () => {
  it("renders the library alone: sdk token then runtime", () => {
    expect(buildUserAgent(undefined, NODE)).toBe(
      `pipelex-sdk-js/${SDK_VERSION} node/22.4.0 (darwin; arm64)`,
    );
  });

  it("puts appInfo before the SDK's own token", () => {
    expect(buildUserAgent({ name: "acme-invoicer", version: "1.4.0" }, NODE)).toBe(
      `acme-invoicer/1.4.0 pipelex-sdk-js/${SDK_VERSION} node/22.4.0 (darwin; arm64)`,
    );
  });

  it("names bun and deno runtimes", () => {
    expect(
      buildUserAgent(undefined, {
        kind: "server",
        name: "bun",
        version: "1.1.0",
        os: "linux",
        arch: "x64",
      }),
    ).toBe(`pipelex-sdk-js/${SDK_VERSION} bun/1.1.0 (linux; x64)`);
    expect(
      buildUserAgent(undefined, {
        kind: "server",
        name: "deno",
        version: "2.0.0",
        os: "linux",
        arch: "x86_64",
      }),
    ).toBe(`pipelex-sdk-js/${SDK_VERSION} deno/2.0.0 (linux; x86_64)`);
  });

  it("omits the runtime token when its version cannot be read", () => {
    expect(buildUserAgent(undefined, { kind: "server" })).toBe(`pipelex-sdk-js/${SDK_VERSION}`);
  });

  it("omits the platform comment when os and arch are unknown", () => {
    expect(buildUserAgent(undefined, { kind: "server", name: "node", version: "22.4.0" })).toBe(
      `pipelex-sdk-js/${SDK_VERSION} node/22.4.0`,
    );
  });

  it("returns undefined in a browser, even with appInfo", () => {
    expect(buildUserAgent(undefined, { kind: "browser" })).toBeUndefined();
    expect(buildUserAgent({ name: "acme" }, { kind: "browser" })).toBeUndefined();
  });

  it("still refuses an invalid appInfo in a browser", () => {
    expect(() => buildUserAgent({ name: "bad name" }, { kind: "browser" })).toThrow(TypeError);
  });

  it("still refuses an appInfo over the ceiling in a browser", () => {
    const details = Array.from({ length: 60 }, (_, i) => `detail-${i}=value`);
    expect(() => buildUserAgent({ name: "acme", details }, { kind: "browser" })).toThrow(
      RangeError,
    );
  });

  it("refuses a header over the ceiling with a RangeError instead of truncating", () => {
    const details = Array.from({ length: 60 }, (_, i) => `detail-${i}=value`);
    expect(() => buildUserAgent({ name: "acme", details }, NODE)).toThrow(RangeError);
    const fits = buildUserAgent({ name: "acme", details: ["a"] }, NODE)!;
    expect(fits.length).toBeLessThanOrEqual(MAX_USER_AGENT_LENGTH);
  });

  it("detects the current runtime by default (the suite runs on Node)", () => {
    expect(buildUserAgent()).toBe(
      `pipelex-sdk-js/${SDK_VERSION} node/${process.versions.node} (${process.platform}; ${process.arch})`,
    );
  });
});

describe("detectRuntime", () => {
  it("reads node from process", () => {
    expect(
      detectRuntime({ process: { versions: { node: "22.4.0" }, platform: "linux", arch: "x64" } }),
    ).toEqual({ kind: "server", name: "node", version: "22.4.0", os: "linux", arch: "x64" });
  });

  it("prefers bun over node when both versions are present", () => {
    expect(
      detectRuntime({
        process: { versions: { node: "22.0.0", bun: "1.1.0" }, platform: "darwin", arch: "arm64" },
      }),
    ).toEqual({ kind: "server", name: "bun", version: "1.1.0", os: "darwin", arch: "arm64" });
  });

  it("prefers deno over its Node-compatible process", () => {
    expect(
      detectRuntime({
        Deno: { version: { deno: "2.0.0" }, build: { os: "linux", arch: "x86_64" } },
        process: { versions: { node: "22.0.0" }, platform: "linux", arch: "x64" },
      }),
    ).toEqual({ kind: "server", name: "deno", version: "2.0.0", os: "linux", arch: "x86_64" });
  });

  it("reports a window with a document as a browser", () => {
    expect(detectRuntime({ window: { document: {} } })).toEqual({ kind: "browser" });
  });

  it("reports a web worker as a browser", () => {
    expect(detectRuntime({ importScripts: () => undefined })).toEqual({ kind: "browser" });
  });

  it("reports an unknown runtime with no version", () => {
    expect(detectRuntime({})).toEqual({ kind: "server" });
    expect(detectRuntime({ window: {} })).toEqual({ kind: "server" });
  });
});

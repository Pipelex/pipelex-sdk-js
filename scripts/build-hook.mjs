/**
 * Bundle the `.mthds` PostToolUse hook into a single dependency-free ESM file
 * (`dist-hooks/check.mjs`), ready to vendor into `pipelex-plugins` as a static
 * hook asset.
 *
 * `@pipelex/tools-wasm` is unpublished, so it is resolved via an esbuild alias
 * pointing at the sibling `vscode-pipelex` checkout (override with
 * PIPELEX_TOOLS_WASM_PATH). Its base64-inlined WASM dominates the artifact
 * size — build it in release mode first (`RELEASE=true make tools-wasm` in
 * vscode-pipelex). Once the package is on npm, drop the alias and add it as a
 * devDependency (and delete `src/hooks/tools-wasm.d.ts`).
 */

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const toolsWasmDir = resolve(
  repoRoot,
  process.env.PIPELEX_TOOLS_WASM_PATH ?? "../vscode-pipelex/js/tools-wasm",
);
const toolsWasmEntry = resolve(toolsWasmDir, "dist/index.js");
if (!existsSync(toolsWasmEntry)) {
  console.error(
    `@pipelex/tools-wasm bundle not found at ${toolsWasmEntry}.\n` +
      "Build it first (RELEASE=true make tools-wasm in vscode-pipelex), or point " +
      "PIPELEX_TOOLS_WASM_PATH at a checkout that has dist/index.js.",
  );
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));
const sdkVersion = readJson(resolve(repoRoot, "package.json")).version;
const toolsWasmVersion = readJson(resolve(toolsWasmDir, "package.json")).version;
const gitOf = (dir) => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: dir, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
};

const banner = `// check.mjs — .mthds PostToolUse hook (lint/format local via WASM, validate via Pipelex API)
// GENERATED FILE — do not edit. Rebuild with \`npm run build:hook\` in pipelex-sdk-js.
// Provenance: @pipelex/sdk ${sdkVersion} (${gitOf(repoRoot)}) + @pipelex/tools-wasm ${toolsWasmVersion} (${gitOf(toolsWasmDir)})`;

await build({
  entryPoints: [resolve(repoRoot, "src/hooks/claude-mthds-check.ts")],
  outfile: resolve(repoRoot, "dist-hooks/check.mjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  alias: { "@pipelex/tools-wasm": toolsWasmEntry },
  banner: { js: banner },
  legalComments: "none",
  logLevel: "info",
});

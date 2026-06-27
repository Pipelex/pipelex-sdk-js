/**
 * dependency-cruiser config — enforces the one-way boundary this SDK rests on:
 *
 *   `@pipelex/sdk` depends on `mthds` for the pure MTHDS Protocol wire types,
 *   and ONLY through the published `mthds/protocol` subpath — never a deep
 *   import into `mthds` internals (`mthds/dist/...`, `mthds/src/...`). Pinning
 *   to the subpath keeps the product client tied to the standard's public
 *   surface, so it can't silently diverge from the protocol.
 *
 *   The protocol re-export layer (`src/protocol/`, added in the client phase)
 *   mirrors `mthds/protocol` for one-stop consumer imports. It must stay pure:
 *   it re-exports types and must not pull in the transport/product modules
 *   (`src/client/`). These rules are seeded now and bind once those modules land.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-mthds-internals",
      severity: "error",
      comment:
        "Import MTHDS protocol types only via the published `mthds/protocol` subpath — never deep-import `mthds` internals.",
      from: { path: "^src/" },
      to: { path: "^mthds/(?!protocol)" },
    },
    {
      name: "protocol-reexport-stays-pure",
      severity: "error",
      comment:
        "src/protocol/ re-exports the MTHDS protocol surface — it must not import the transport/product client. Keep it a pure type barrel.",
      from: { path: "^src/protocol/" },
      to: { path: "^src/client/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // With tsConfig + tsPreCompilationDeps, dependency-cruiser drives the
    // TypeScript resolver, which natively maps ESM `.js` import specifiers to
    // their `.ts` source — so the `to.path` matches real on-disk modules.
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};

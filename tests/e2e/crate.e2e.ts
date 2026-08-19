/**
 * E2E suite for the crate routes — `resolve` and `codegen` — exercised against a
 * LIVE pipelex-api server (no fetch mocks).
 *
 * Run with `make test-e2e` (or `npm run test:e2e`) against a local runner:
 *
 *     PIPELEX_E2E_BASE_URL=http://localhost:8081 npm run test:e2e
 *
 * These are the tests the unit suite cannot write. Every mock in the repo agrees with
 * the client about the field names, so a typo in the request body (`kind`/`target`
 * misspelled, a `target` value the server's enum does not serve) is invisible until a
 * real server parses it. That is exactly what this suite catches — and the `target`
 * vocabulary in particular is a mirror of a Python `StrEnum` in another repo, so
 * nothing but a live call proves the two still agree.
 *
 * The through-line is the same verdict discipline the build routes share with
 * `validate`: an unresolvable CLOSURE is a produced verdict on a **200**
 * (`is_valid: false` + `validation_errors[]`), while an unresolvable REQUEST — a
 * `pipe_ref` on the concept-set-wide `types` kind, the reserved `method_ref` — is
 * non-2xx and surfaces as the typed `ApiResponseError`.
 *
 * The last block runs `runCodegenCheck` over what the server just emitted. The unit
 * suite pins that port against vendored bytes; only a live call proves it agrees with
 * the stamp grammar and lock format the SERVER writes today — which is the pairing
 * that matters, since a consumer commits the server's artifacts and gates CI on the
 * SDK's verdict about them.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { PipelexApiClient } from "../../src/client.js";
import { isStampableArtifactPath, runCodegenCheck } from "../../src/codegen-check.js";
import type { CodegenCheckInput } from "../../src/codegen-check.js";
import { ApiResponseError } from "../../src/errors.js";
import type {
  CodegenTarget,
  CodegenValidReport,
  CrateInvalidReport,
  ResolveValidReport,
} from "../../src/models.js";
import { handEdit, regenerate } from "../helpers/codegen-stamp.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

// ── Fixtures ─────────────────────────────────────────────────────────────

/** One domain, one pipe, one structured concept — enough for `types` to project something. */
const VALID_BUNDLE = `domain = "smoke"
main_pipe = "echo"

[concept.Customer]
description = "A customer"

[concept.Customer.structure]
name = { type = "text", description = "Customer name" }

[pipe.echo]
type = "PipeLLM"
description = "Echo"
inputs = { text = "Text" }
output = "Customer"
prompt = "@text"
`;

/** An INVALID closure — `main_pipe` is not even a legal pipe code (the syntax arm). */
const INVALID_BUNDLE = `domain = "broken"
description = "Invalid main_pipe"
main_pipe = "Not A Valid Pipe Code!"

[concept.Customer]
description = "A customer"
`;

// ── Suite ────────────────────────────────────────────────────────────────

const client = new PipelexApiClient({
  baseUrl: BASE_URL,
  apiKey: process.env.PIPELEX_API_KEY || "e2e-test",
});

beforeAll(async () => {
  try {
    // `/v1/version`, not the origin-level `/health`: only this one is served by BOTH a
    // bare runner and a hosted origin, so the probe stays honest wherever BASE_URL points.
    await client.version();
  } catch (err) {
    throw new Error(
      `No pipelex-api reachable at ${BASE_URL}. Start one (e.g. in ../pipelex-api) ` +
        `or point PIPELEX_E2E_BASE_URL (shell or .env) at a running instance.`,
      { cause: err },
    );
  }
});

describe("e2e resolve (/v1/resolve)", () => {
  it("emits the normalized crate with its fingerprint riding inside the payload", async () => {
    const result = await client.resolve({
      files: [{ content: VALID_BUNDLE, source: "smoke.mthds" }],
    });

    expect(result.is_valid).toBe(true);
    const report = result as ResolveValidReport;
    // `fingerprint` and `mthds_version` are crate members, not siblings of `crate` —
    // a consumer that looked for them beside it would find nothing.
    expect(typeof report.crate.fingerprint).toBe("string");
    expect(report.crate.mthds_version).toBeDefined();
    expect(report.crate.domains).toMatchObject({ smoke: expect.any(Object) });
  });

  it("returns an unresolvable closure as a 200 verdict, not a throw", async () => {
    const result = await client.resolve({
      files: [{ content: INVALID_BUNDLE, source: "broken.mthds" }],
    });

    expect(result.is_valid).toBe(false);
    const report = result as CrateInvalidReport;
    // Non-empty on every invalid verdict — the structured-info invariant.
    expect(report.validation_errors.length).toBeGreaterThan(0);
    expect(report.validation_errors[0]!.message).toEqual(expect.any(String));
  });

  it("answers 501 for the reserved method_ref selector", async () => {
    const failure = client.resolve({ method_ref: "acme/method@1" });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 501 });
  });
});

describe("e2e codegen (/v1/codegen)", () => {
  it("projects the concept set into stamped ts-zod artifacts plus a lock", async () => {
    const result = await client.codegen({
      files: [{ content: VALID_BUNDLE, source: "smoke.mthds" }],
      kind: "types",
      target: "ts-zod",
    });

    expect(result.is_valid).toBe(true);
    const report = result as CodegenValidReport;
    // The echoed axes prove the wire vocabulary still matches the server's enums.
    expect(report.kind).toBe("types");
    expect(report.target).toBe("ts-zod");
    expect(report.crate_fingerprint).toEqual(expect.any(String));
    expect(report.engine_version).toEqual(expect.any(String));
    expect(report.artifacts.length).toBeGreaterThan(0);
    expect(report.artifacts[0]!.path).toEqual(expect.any(String));
    expect(report.artifacts[0]!.content.length).toBeGreaterThan(0);
    // The lock is what makes the artifacts checkable offline — it must arrive as
    // ready-to-write content plus the exact filename to write it as.
    expect(report.lock.length).toBeGreaterThan(0);
    expect(report.lock_filename).toBe("codegen.lock");
  });

  // Every declared `CodegenTarget` gets a live call. The type is a hand-written mirror
  // of a Python StrEnum in another repo, so a member the server no longer serves is
  // invisible to the type-checker and to every mocked test — this loop is the only
  // thing that would go red. Kept exhaustive on purpose: covering two of three would
  // leave exactly the untested member free to rot.
  it.each<CodegenTarget>(["ts-zod", "python-pydantic", "python-structures"])(
    "serves the %s target",
    async (target) => {
      const result = await client.codegen({
        files: [{ content: VALID_BUNDLE }],
        kind: "types",
        target,
      });

      expect(result.is_valid).toBe(true);
      const report = result as CodegenValidReport;
      expect(report.target).toBe(target);
      expect(report.artifacts.length).toBeGreaterThan(0);
    },
  );

  it("agrees with resolve on the crate fingerprint for the same closure", async () => {
    const files = [{ content: VALID_BUNDLE, source: "smoke.mthds" }];
    const resolved = (await client.resolve({ files })) as ResolveValidReport;
    const generated = (await client.codegen({
      files,
      kind: "types",
      target: "python-pydantic",
    })) as CodegenValidReport;

    // Both routes resolve the SAME closure through the same engine core; a mismatch
    // would mean the artifacts were stamped against a crate the caller never saw.
    expect(generated.crate_fingerprint).toBe(resolved.crate.fingerprint);
  });

  it("returns an unresolvable closure as a 200 verdict, not a throw", async () => {
    const result = await client.codegen({
      files: [{ content: INVALID_BUNDLE, source: "broken.mthds" }],
      kind: "types",
      target: "ts-zod",
    });

    expect(result.is_valid).toBe(false);
    expect((result as CrateInvalidReport).validation_errors.length).toBeGreaterThan(0);
  });

  it("rejects a pipe_ref on the concept-set-wide types kind as a request-shape 422", async () => {
    // Not an invalid-crate verdict: nothing is wrong with the closure. Silently
    // ignoring the selector would mislead the caller into believing the artifacts
    // were narrowed to one pipe.
    const failure = client.codegen({
      files: [{ content: VALID_BUNDLE }],
      kind: "types",
      target: "ts-zod",
      pipe_ref: "smoke.echo",
    });
    await expect(failure).rejects.toBeInstanceOf(ApiResponseError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
  });
});

// ── The offline check, over live server bytes ────────────────────────────

/**
 * The two flavors worth checking live: one per comment syntax the stamp grammar
 * supports. `python-structures` shares `python-pydantic`'s `#` prefix, so a third
 * pass would re-exercise the same parser branch — the exhaustive `target` loop above
 * is what guards the vocabulary.
 */
const CHECKED_TARGETS: ReadonlyArray<{
  target: CodegenTarget;
  commentPrefix: string;
  strayPath: string;
}> = [
  { target: "ts-zod", commentPrefix: "//", strayPath: "stale/dropped.ts" },
  { target: "python-pydantic", commentPrefix: "#", strayPath: "stale/dropped.py" },
];

describe.each(CHECKED_TARGETS)(
  "e2e offline check over live $target artifacts",
  ({ target, commentPrefix, strayPath }) => {
    let generated: CodegenValidReport;

    beforeAll(async () => {
      const result = await client.codegen({
        files: [{ content: VALID_BUNDLE, source: "smoke.mthds" }],
        kind: "types",
        target,
      });
      expect(result.is_valid).toBe(true);
      generated = result as CodegenValidReport;
    });

    /**
     * The response feeds the check with NO mapping: `GeneratedArtifact` and
     * `CodegenTreeFile` are structurally identical on purpose, and this call site is
     * what would stop compiling if either drifted.
     */
    const tree = (): CodegenCheckInput => ({
      lockContent: generated.lock,
      files: generated.artifacts,
    });

    /** The first artifact, by the same path sort the check reports drifts in. */
    const firstPath = (): string => [...generated.artifacts].map((a) => a.path).sort()[0]!;

    const contentAt = (path: string): string =>
      generated.artifacts.find((artifact) => artifact.path === path)!.content;

    it("verifies the server's own artifacts as current", async () => {
      const report = await runCodegenCheck(tree());

      expect(report.drifts).toEqual([]);
      expect(report.isCurrent).toBe(true);
      // The lock header the check parsed must be the one the route reported beside it;
      // a mismatch would mean the artifacts were stamped against a crate the caller
      // never saw. (The check itself never compares them — that is the caller's move,
      // and this is the field that makes it possible.)
      expect(report.crateFingerprint).toBe(generated.crate_fingerprint);
      expect(report.engineVersion).toBe(generated.engine_version);
    });

    it("emits only artifact types a caller's tree walk would pick up", () => {
      // The consumer filters its walk with `isStampableArtifactPath`; an artifact type
      // outside that set would be invisible to the walk and silently unchecked.
      for (const artifact of generated.artifacts) {
        expect(isStampableArtifactPath(artifact.path)).toBe(true);
      }
    });

    it("reports a deleted artifact as `missing`", async () => {
      const path = firstPath();
      const report = await runCodegenCheck({
        ...tree(),
        files: generated.artifacts.filter((artifact) => artifact.path !== path),
      });

      expect(report.isCurrent).toBe(false);
      expect(report.drifts).toEqual([
        { path, category: "missing", detail: "Locked artifact is absent on disk." },
      ]);
    });

    it("reports a body edited below the stamp as exactly one `hand-edited` drift", async () => {
      const path = firstPath();
      const report = await runCodegenCheck({
        ...tree(),
        files: generated.artifacts.map((artifact) =>
          artifact.path === path
            ? { ...artifact, content: handEdit(artifact.content, "EDITED\n", commentPrefix) }
            : artifact,
        ),
      });

      // One drift, not two: the edit trips the stamp check AND the lock check, and the
      // stamp verdict wins. Reported twice, a consumer would print the same file twice
      // under contradictory categories.
      expect(report.drifts).toEqual([
        {
          path,
          category: "hand-edited",
          detail: "Body was edited below the stamp (stamp hash no longer matches).",
        },
      ]);
    });

    it("reports a regenerated body against the stale lock as `modified`", async () => {
      const path = firstPath();
      const report = await runCodegenCheck({
        ...tree(),
        files: generated.artifacts.map((artifact) =>
          artifact.path === path
            ? { ...artifact, content: regenerate(artifact.content, "NEWER\n", commentPrefix) }
            : artifact,
        ),
      });

      // Body and stamp agree with each other and only the lock is stale — what a real
      // regeneration against a changed method looks like before the lock is committed.
      expect(report.drifts).toEqual([
        {
          path,
          category: "modified",
          detail: "Body no longer matches the locked hash — regenerate.",
        },
      ]);
    });

    it("reports a stamped file the lock does not track as an `orphan`", async () => {
      // A real stale artifact: yesterday's generated file, still stamped, left behind
      // after the concept it projected was deleted. Only the lock can catch this one.
      const report = await runCodegenCheck({
        ...tree(),
        files: [...generated.artifacts, { path: strayPath, content: contentAt(firstPath()) }],
      });

      expect(report.drifts).toEqual([
        {
          path: strayPath,
          category: "orphan",
          detail: "Stamped generated file not tracked by the lock — stale; remove or regenerate.",
        },
      ]);
    });
  },
);

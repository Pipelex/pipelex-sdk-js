# Codegen check fixtures

Real `pipelex codegen types` output, vendored verbatim. The suite hashes these bytes, so a
verdict computed by `runCodegenCheck` is provably the verdict `pipelex codegen check` computes
over the same tree — which a hand-written stamp could never demonstrate.

Artifacts carry a trailing `.txt` (`types.ts.txt`, `models.py.txt`) and the suite restores the
real name at load time. Without it, `format:check`, `lint`, and `typecheck:test` all glob
`tests/**/*.ts` and would reformat (or redden) the very bytes the fixture exists to pin —
this repo formats at `printWidth: 100` while the ts-zod emitter targets Prettier's 80-column
default, and `types.ts` imports `zod`, which is not a dependency here.

## Regenerating

From `smoke.mthds` (the source bundle, committed beside the output), with a pipelex checkout:

```bash
mkdir -p /tmp/codegen-fixtures/lib && cp smoke.mthds /tmp/codegen-fixtures/lib/
cd /tmp/codegen-fixtures
pipelex codegen types --target ts-zod         --library-dir lib --output out-ts
pipelex codegen types --target python-pydantic --library-dir lib --output out-py
```

Then copy `out-ts/codegen.lock`, `out-ts/types.ts` → `ts-zod/types.ts.txt`, `out-ts/binder.ts`
→ `ts-zod/binder.ts.txt`, and the `out-py` pair into `python-pydantic/`. The suite's
`CRATE_FINGERPRINT` and `ENGINE_VERSION` constants come from the new lock headers.

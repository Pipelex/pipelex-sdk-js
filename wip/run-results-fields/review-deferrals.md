---
status: active
item: L-260918-80bd71
---

# Deferred from the review of the run-results fields

Round 3 at profile 4, bar `necessity`, on `feature/Run-results-fields`, reviewed at `737c6e8`. Cubic and `code-review` found nothing, and the one independent reader found nothing necessary. The bar admits only what the branch should not merge with, so these two real findings were left, and this is where they are recorded.

## `mode: "live"` is described at the wrong level

`docs/run-results.md` (the opening of the `graph_spec` section) and the `graph_spec` JSDoc in `src/runs.ts` both describe the executed graph as `mode: "live"`, as if `mode` were a top-level key. It is not: it lives at `meta.mode`, both in the runner's `GraphSpec` model, which forbids extra fields, and in `@pipelex/mthds-ui`'s, whose `graphSpecMode()` reads `spec?.meta?.mode` (`mthds-ui/src/graph/types.ts`). This branch's own test fixtures already write `meta: { format: "mthds", mode: "live" }`.

**Why it was not necessary.** Nothing on the page tells a reader to branch on `mode`, and the page's recommended path casts the value to `GraphSpec`, which would reject `.mode` at compile time, so a reader following the page finds the right level on their own. **The fix is to write `meta.mode: "live"` in both places**, and the natural moment is the next change that edits this page: the artifact stack's own section is due on it.

## The changelog entries do not follow the entry shape

The workspace's changelog rule asks for `- **Title**: …` in one to three sentences. This branch's entries separate the title with an em dash rather than a colon, and the first runs as one long sentence. "The blocking path stops dropping the executed graph" is also arguably a `### Fixed` entry rather than a `### Changed` one, since the graph was always on the wire and the SDK was discarding it.

**Why it was not necessary.** It is shape, not content: every entry says what a consumer can now see, names the surface, and carries no ledger id and no `wip/` citation.

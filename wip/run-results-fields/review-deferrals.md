---
status: active
item: L-260918-80bd71
---

# Deferred from the review of the run-results fields

Round 3 at profile 4, bar `necessity`, on `feature/Run-results-fields`, reviewed at `737c6e8`. Cubic and `code-review` found nothing, and the one independent reader found nothing necessary. The bar admits only what the branch should not merge with, so the real finding it left is recorded here.

## The changelog entries do not follow the entry shape

The workspace's changelog rule asks for `- **Title**: …` in one to three sentences. This branch's entries separate the title with an em dash rather than a colon, and the first runs as one long sentence. "The blocking path stops dropping the executed graph" is also arguably a `### Fixed` entry rather than a `### Changed` one, since the graph was always on the wire and the SDK was discarding it.

**Why it was not necessary.** It is shape, not content: every entry says what a consumer can now see, names the surface, and carries no ledger id and no `wip/` citation.

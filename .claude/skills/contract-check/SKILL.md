---
name: contract-check
description: Detect interface-contract drift between @pipelex/sdk's client surface and the wire specs it implements (defaults to comparing against the last release tag, but the user can specify any tag or commit). Compares the PipelexApiClient request/response shapes against the protocol and validation specs in ../docs/specs/. Use when the user says "check the contract", "contract review", "contract check", "did we break the contract", "check interfaces", "API contract", "protocol drift", "compare to vX.Y.Z", or before shipping/releasing a version that touches the client wire surface. Also trigger automatically before the /release skill runs.
---

# Contract Check

Detects discrepancies between the wire surface `@pipelex/sdk` implements and the specs that document it. The SDK's `PipelexApiClient` is a client of the Pipelex hosted API: it re-implements the official MTHDS protocol routes (`execute` / `start` / `validate` / `models` / `version`) using `mthds/protocol` types, and adds the Pipelex-product routes (methods catalog, organizations, billing, API keys, storage, onboarding). A discrepancy means the code and the spec disagree — but this skill does NOT presume which side is wrong. The code may need fixing, the spec may need updating, or both. That judgment belongs to the human reviewing the report.

## Prerequisites: Locate the Specs

The specs live at `../docs/specs/` (relative to this repo root, i.e. the sibling workspace-root `docs` directory). Before doing anything else:

1. Check that the directory `../docs/specs/` exists.
2. Check that it contains `pipelex-mthds-protocol.md` and `pipelex-validation-api.md`.

If the directory is missing or does not contain the expected spec files, **stop immediately** and tell the user the specs directory was not found and they need access to the workspace-root `docs`/`specs`.

### The spec set in scope

Only these touch `@pipelex/sdk` code:

| Spec | The SDK's relationship |
|---|---|
| `pipelex-mthds-protocol.md` | **implements/consumes** — `PipelexApiClient` is a protocol client; the wire shapes (validate report + model deck, version handshake, RFC 7807 errors, `pipe_ref` identity) are this spec |
| `pipelex-validation-api.md` | **implements/consumes** — the `/v1/validate` verdict surface (`PipelexValidationResult` discriminated on `is_valid`, presentation-vs-contract) |

`command-surface-map.md` gives the cross-repo view; consult it for context but the two specs above are the ones the SDK rides.

## Step 1 — Identify the Baseline

If the user specified a baseline (e.g. "compare to v0.1.3"), use it. Otherwise default to the latest release tag:

```bash
git tag --sort=-v:refname | head -1
```

Confirm the baseline with the user before proceeding.

## Step 2 — Detect Contract-Affecting Changes

Diff the baseline against HEAD, scoped to the client wire surface:

```bash
git diff <baseline-tag> HEAD --name-only -- src/client/ src/models/ src/errors/ src/protocol/ CHANGELOG.md
```

(Adjust the paths to the actual client layout. `src/protocol/` is the re-exported MTHDS surface; `src/client/`, `src/models/`, `src/errors/` carry the request pipeline, request/response models, and typed errors.)

If **no files changed**, report that no contract-affecting changes were detected and stop. Otherwise proceed.

## Step 3 — Classify the Changes

For each changed file, get the diff (`git diff <baseline-tag> HEAD -- <file>`) and classify each change as:

- **Contract-visible**: changes to route paths, request/response models, wire-shape fields, HTTP status semantics, error shapes/types, or the validate verdict discriminant.
- **Internal-only**: refactors, logging, cosmetic changes that don't affect the wire.

Also scan CHANGELOG entries since the baseline for mentions of new/removed/renamed routes or fields, changed verdict/error protocol, or HTTP status semantics.

## Step 4 — Review Against Specs

For each contract-visible change, read the relevant spec and determine:

1. **Is the change documented in the spec?**
2. **Does the change contradict the spec?**
3. **Is the change absent from the spec?**

| What changed | Spec to check |
|---|---|
| Protocol routes — validate report/result union, model deck, version handshake, request/response models, HTTP status semantics, RFC 7807 error bodies, `pipe_ref` identity | `../docs/specs/pipelex-mthds-protocol.md` |
| The `/v1/validate` verdict (`PipelexValidationResult`, `is_valid` discriminant, presentation-vs-contract) | `../docs/specs/pipelex-validation-api.md` |

**When citing a spec surface, note its conformance status.** Each verified surface carries a `> Verified by:` line pointing at the `conformance/` test that exercises it (or an explicit unverified marker). Include that target so the reviewer knows whether a test already guards it.

## Step 5 — Report

Produce a **self-contained** report (readable by an agent in another repo). Start with a header block (date, repo `@pipelex/sdk`, branch, baseline, target HEAD, specs checked), then a summary table (Discrepancies / Unmatched additions / Aligned changes with counts and a one-line verdict), then detailed sections:

- **Discrepancies** — for each: what the code does (file:line), what the spec says (file:section + conformance status), and which side moved. Do NOT prescribe the fix.
- **Unmatched additions** — behaviors present in only code or only spec; state which side has it.
- **Aligned changes** — brief list for completeness.

## Step 6 — File the Actionable Findings as Ledger Items

The report is printed, never saved to a file: a saved report is the ad hoc follow-up list the workspace ledger replaced. Each discrepancy or unmatched addition that somebody must act on becomes one workspace ledger item. Aligned changes stay in the printed report.

- **Ask which side moves before filing.** This skill does not decide whether the code or the spec is wrong, so the owner comes from the user's answer: a code fix is owned by `pipelex-sdk-js`, a spec edit by `workspace`, since `docs/specs/` lives in the meta-repo. A finding the user leaves undecided is filed as a `decision` owned by `workspace`, its body naming both sides.
- **Fix in place what belongs here, except under a release.** A finding whose fix is a small, obvious change in this repo is made in this session, after asking the user; it is filed only when it is genuinely out of scope. When `/release` runs this skill, nothing is fixed in place: the release commit stages only its own files by name, so a fix made in the release worktree would stay uncommitted or ride into `main` without a topic branch and its `/rev`. File it instead.
- **Check for an existing item first**, since this check runs before every release and the same drift resurfaces: `ledger list --ref skill:contract-check --status open`. When an open item covers the finding, record the sighting on it (`ledger note <id> "Still open at baseline <baseline> → HEAD <short-sha>."`) and name the id in the report.
- **File the rest** with `ledger new --owner <repo> --type bug|spec|task|decision --title "…" --gist "…" --ref skill:contract-check`, the body carrying the report's evidence for that finding (file:line, spec section, conformance status), so an agent in `docs` or `conformance` can act without this repo. The `/ledger` skill has the full command reference.

## Notes

- **Specs and conformance are a linked pair.** If a finding's resolution is to edit a spec, the matching `conformance/` test must change in the same commit, and `make check-spec-links` (run in the `conformance/` repo) must pass — it enforces the bidirectional `> Verified by:` ↔ `pytestmark = pytest.mark.spec(...)` links.
- The most critical surface is the protocol wire shape, because AI agents, the plugin, and `pipelex-app` depend on its exact format.
- This skill detects discrepancies — it does not assign blame. Code, spec, or both may need updating. That's a human decision.

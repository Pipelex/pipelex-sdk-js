---
name: release
description: >
  Cut a release of pipelex-sdk-js, the TypeScript SDK for the Pipelex hosted API
  published to npm as @pipelex/sdk: the release/vX.Y.Z worktree, the
  package.json bump with the SDK_VERSION literal and the package-lock.json that
  follows, the changelog entry, the contract check and the quality gates, one
  commit, and a pull request to main. Use when the user says "release", "cut a
  release", "bump version", "new version", "prepare a release", "make a
  release", "ship it", "create release branch", "promote dev to main", or any
  variation of shipping a new version of the SDK. Changelog content passed
  inline ("/release Added a typed run source") becomes the entry. The merge is
  landed by /ledger-land, never by this skill.
---

# Releasing pipelex-sdk-js

The procedure is the workspace release play, [`docs/releasing.md`](../../../../docs/releasing.md) at the workspace root — `../docs/releasing.md` from this repo's own root, which resolves the same from the main checkout and from any worktree. Read it first, then run it with what follows. The repo key is `pipelex-sdk-js`, the base is `dev`, and the pull request targets `main`: `guard-branches.yml`'s `gate-main` fails any head into `main` that is not `release/vX.Y.Z`, and any head that comes from a fork. The release worktree is `_pipelex-sdk-js--release`, made with `wt add pipelex-sdk-js release --branch release/vX.Y.Z`. The repo declares neither `.worktree.toml` nor `.worktreeinclude`, so `wt` resolves the base from `origin/dev`, copies `.env` — its default when the main checkout has one — and provisions with the Makefile's `install` target, which is the `npm install` every gate below runs out of.

## What ships

`publish.yml` is the whole publish, and it fires on the **push to `main`** (`on: push: branches: [main]`), so its run is keyed to the merge commit. It authenticates to npm by OIDC trusted publishing (`id-token: write` and `npm publish --access public --provenance`), never a long-lived token, and its concurrency group does not cancel in progress, so two merges cannot race into a double publish.

- **The `@pipelex/sdk` package on npm.** Before building anything the workflow asks npm whether the version already exists (`npm view "@pipelex/sdk@$VERSION" version`) and, when it does, skips the install, the build, the publish, the tag and the Release. A push to `main` that did not bump the version is therefore a **green run that ships nothing**, not a failure — the only thing standing between an unbumped release and that silent no-op is `version-check.yml` on the pull request, which requires the version to be strictly greater than the one on `main`.
- **The `vX.Y.Z` tag**, made by the same job with `git tag "v$VERSION"` and pushed. It is lightweight, so always read tags with `--tags`; a bare `git describe` finds no annotated tag here.
- **The GitHub Release**, by the `github-release` job, which runs only when the publish job reported `already_published == 'false'`. Its notes are the changelog section for the version, sliced between the `## [vX.Y.Z] - ` heading and the next `^## [v…] - ` heading, with blank lines dropped and each line's surrounding whitespace stripped. When no such heading is found the step warns, sets the notes empty and exits 0, so the Release ships carrying the bare line `Release vX.Y.Z` rather than failing.

The landing verifies the publish — the run, the registry's answer, the tag:

```bash
gh run list --workflow=publish.yml --branch main --limit 3 --json conclusion,headSha,url  # the run whose headSha is the merge SHA: success
npm view @pipelex/sdk version                                                             # the registry's answer: X.Y.Z
git fetch --tags --prune origin && git tag --list vX.Y.Z                                  # the tag
```

A re-run cannot finish a half-done release. Once the package is on npm the already-published check turns the publish job into a no-op, which skips the tag step and, because the Release job is gated on that same output, skips the Release as well: a run that published but failed before pushing the tag leaves the tag and the Release to be made by hand.

## Version files and the lock

- **`package.json`** — the top-level `"version"`, with no `v` prefix. Read by `version-check.yml` and `publish.yml` alike through `node -p "require('./package.json').version"`, so it is the number everything else is compared against.
- **`src/index.ts`** — `export const SDK_VERSION = "X.Y.Z";`, bumped in lockstep and with no `v` prefix. It is a hand-maintained literal on purpose, so the constant ships bundler-safe with no runtime file read in consumer code.
- **The lock** — `npm install --package-lock-only` after the bump, which rewrites `package-lock.json`'s version fields without touching `node_modules`. Stop and report a failure rather than committing a stale lock.
- **Also stamped:** nothing else. The number lives in those two files alone — no README badge, no literal in the docs. (`docs/architecture.md` and `src/models.ts` cite `pipelex-api` version numbers, and `src/client.ts` cites those alongside a historical note on this package's own `v0.10.0`, when `listRuns` changed shape — prose about the past, never a stamp to move.)

## Gates

Run in the worktree, in this order:

1. **`/contract-check`**, this repo's own skill — it compares the `PipelexApiClient` wire surface against the workspace-root specs `docs/specs/pipelex-mthds-protocol.md` and `docs/specs/pipelex-validation-api.md`, which it reaches as `../docs/specs/` and refuses to run without. From `_pipelex-sdk-js--release` that path resolves to the same directory it does from the main checkout, because every worktree sits flat at the workspace root. It matters most when the branch touched `src/client.ts`, `src/models.ts` or the barrel's protocol re-exports. Its verdict is advisory by design — it reports drift without presuming which side is wrong — so a finding is a decision to put to the user, not an automatic stop.
2. **`make all`** — `clean check test`: `npm run check` is eslint, `prettier --check`, `tsc --noEmit`, the `tsconfig.test.json` typecheck, the `tsc` build and `depcruise --config .dependency-cruiser.cjs src`, and then `npx vitest run`. This is exactly what `quality-checks.yml` runs on the pull request, so a red one here is a red pull request there. Nothing in it rewrites a tracked file: the format gate is `prettier --check`, and its cure is `npm run format`, whose rewrites then join the release commit. Red blocks the release — fix the code, never loosen the target.
3. **`make test` again, after the bump.** `tests/index.test.ts` asserts that `SDK_VERSION` matches `/^\d+\.\d+\.\d+$/` and equals `package.json`'s version, so the suite is the only thing that catches a `src/index.ts` left behind by the bump.

`make test-e2e` is **not** a gate. It needs a live `pipelex-api` at `PIPELEX_E2E_BASE_URL` (default `http://localhost:8081`, read from the shell or `.env`), and it is excluded from `make test` and `make all` for that reason.

## The release commit

`package.json`, `package-lock.json`, `src/index.ts`, `CHANGELOG.md`, and anything `npm run format` rewrote — staged by name.

## CI on the release pull request

- **`guard-branches.yml`** (`gate-main`) — the head into `main` matches `^release/v[0-9]+\.[0-9]+\.[0-9]+$` and belongs to this repository rather than a fork.
- **`version-check.yml`** — both of its checks apply to the release pull request, since its head is a release branch and its base is `main`: `package.json`'s version equals the version in the branch name, **and** it is strictly greater than the version `main` carries, compared component by component.
- **`changelog-check.yml`** — on a pull request to `main` whose head starts with `release/v`, `CHANGELOG.md` must carry a `## [vX.Y.Z] -` heading for the version in the branch name. It asserts nothing about `[Unreleased]`.
- **`quality-checks.yml`** — `make install` then `make all`, on every pull request — the same target the gates already ran in the worktree.
- **`cla.yml`** — the CLA assistant, on `pull_request_target`, with the maintainer allowlist read from the `CLA_ALLOWLIST` Actions variable.

`guard-branches.yml` and `quality-checks.yml` each open with a header calling their status check the one a branch-protection ruleset on `main` requires. That ruleset is GitHub configuration rather than anything in the tree, so read those headers as the intent and not as a lock to lean on: a red gate stops the release by this play's rule, whatever GitHub happens to be enforcing.

Nothing in CI checks that `package-lock.json` agrees with `package.json`: `quality-checks.yml` installs with `make install` (`npm install`), which quietly updates the lock instead of failing on a stale one. The lock step in the play is the only thing keeping the two in step.

## Particulars

- **No pre-release form.** `changelog-check.yml` enters its job on any head starting with `release/v` and then demands `^release/v([0-9]+\.[0-9]+\.[0-9]+)$`, so `release/v0.18.0-rc.1` does not skip the check the way it would elsewhere — it fails it — and `gate-main` refuses that head into `main` outright. Ship a plain `X.Y.Z`.
- **The changelog heading carries the `v`, and the ` - ` separator is load-bearing.** Entries are `## [vX.Y.Z] - YYYY-MM-DD`: `changelog-check.yml` greps `## \[vX.Y.Z\] -`, and `publish.yml` slices the GitHub Release notes on `## \[vX.Y.Z\] - `, falling back to a bare one-line body when it does not find it.
- **This changelog keeps no `[Unreleased]` section.** Changes are written under their version heading, so the play's folding step usually finds nothing to fold and the entry is drafted from what the pre-flight listed.
- **The `mthds` floor is not the release's business.** `package.json`'s `mthds` dependency range is the SDK's one upstream floor, and it is moved by this repo's `bump-mthds` skill and read by `check-min-versions` — never as a side effect of cutting a release.
- **The generated hook bundle is not the release's business either.** `npm run build:hook` (`scripts/build-hook.mjs`) burns `package.json`'s version and the short HEAD SHA into the provenance banner of `dist-hooks/check.mjs`, which is gitignored here and vendored verbatim into `pipelex-plugins`. Nothing in the gates or in `publish.yml` builds it, and `pipelex-plugins` re-vendors on a change to the hook source under `src/hooks/` rather than on a release, through its own `make vendor-hook`. So it is a version-stamped artifact this play deliberately does not touch.
- **Downstream consumers pin a caret range.** `pipelex-mcp`, `pipelex-app` and `pipelex-starter-js` carry `@pipelex/sdk` in their own `package.json` as `^X.Y.Z`, and npm's caret does not cross a minor on a `0.x` version, so a minor release reaches them only when someone moves the range. `ledger/ledger.toml` declares no `release_followups` for `pipelex-sdk-js`, so nothing arms those bumps: file them yourself alongside the release item.
- **The back-merge takes whichever shape `dev` earned.** The release pull request merges into `main` with a merge commit, and `/ledger-land` then merges `origin/main` back into `dev`. When nothing landed on `dev` after the cut, that merge fast-forwards and there is nothing to resolve; when something did, it makes a `Merge branch 'main' into dev` whose one expected conflict is the changelog. Both shapes are in this repo's history, so a fast-forward is not a step that got skipped.
- **`gate-release` admits a `dev → release/vX.Y.Z` pull request**, which is how work reached an already-cut release before (`main` carries `25789a7 Merge dev into the release: the output_form work lands in 0.17.0`). The play cuts from a `dev` the pre-flight has just pulled, so that shape should not be needed; wanting it means work landed on `dev` after the cut, which is a conversation with the user rather than a step.

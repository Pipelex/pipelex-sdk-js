# Changelog

## [v0.1.0] - 2026-06-27

### Added

- Initial scaffold of `@pipelex/sdk` — the TypeScript SDK for the Pipelex hosted API. House-style toolchain mirrored from `mthds-js`: ESM-only `tsc` build (NodeNext, strict), Vitest 4 with v8 coverage, ESLint 9 flat config, Prettier 3, dependency-cruiser boundary enforcement, and a `Makefile` task surface. CI parity (quality checks, npm OIDC trusted publishing, changelog/version guards). No client logic yet — `SDK_VERSION` placeholder export only.

---
name: check-min-versions
description: >
  Show the minimum required version of the upstream dependency this SDK rests on
  — the `mthds` package (provider of the MTHDS protocol wire types via
  `mthds/protocol`). Read-only: reports the current floor without changing
  anything. Use when the user says "check min versions", "what's the min mthds
  version", "show required versions", "current version floor", or any variation
  of asking what the SDK's upstream minimum is. This is the read-only counterpart
  to the bump-required-versions skill — if the user wants to *change* the floor,
  use that one instead.
---

# Check Required Versions

Reports the one upstream version floor that `@pipelex/sdk` enforces: the **`mthds`** dependency, which provides the MTHDS protocol wire types (`mthds/protocol`) the client builds its routes on. This skill only reads and reports — it never edits. To change the floor, use the `bump-required-versions` skill.

## Workflow

### 1. Read the current value

```bash
node -p "require('./package.json').dependencies?.mthds ?? '(mthds is not yet a dependency)'"
```

Until the client phase adds the dependency, this reports that `mthds` is not yet pinned.

### 2. Report

Present the floor compactly:

```
Dependency  Provides            Constraint            Source
mthds       mthds/protocol      <range or git ref>    package.json (dependencies)
```

Note that the SDK consumes `mthds` only through the `mthds/protocol` subpath, and that while dev-linked the constraint is a git/branch ref rather than a semver range.

That's the whole job. Don't run `make check`, don't edit anything, don't suggest a bump unless the user asks.

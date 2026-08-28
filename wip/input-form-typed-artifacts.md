# Typing the validate report's standard artifacts (input-form program, Stage 3.3)

This repo's half of the workspace input-form program. The program plan is `wip/input-form/plan.md` at the workspace root and the ledger item is `L-260826-beaa05`; this document is the local record the plan's execution protocol asks each owning repo to keep — what was changed here, which calls were taken, and what is deliberately left to other repos.

## What the program decided, and what it asks of this package

The program's decision D-1 rules that the wire types of the input-form descriptor and of the pipe I/O contracts belong to the standard's clients: `mthds/protocol` in TypeScript, `mthds.protocol` in Python. Stage 2 published them — `mthds` 0.23.0 on npm carries `src/protocol/input_form.ts` and `src/protocol/pipe_io_contracts.ts` as types only, and `mthds` 0.9.0 on PyPI carries the pydantic mirrors. Stage 3 then asks every consumer that had been restating or eliding those shapes to import them instead. Item 3.3 is this package's share.

The change here is small on the surface and worth stating precisely, because it reverses a previous ruling and a reader who finds only the reversal will assume it was an accident. `PipelexValidationReport` used to type `pipe_io_contracts` and `input_form` as opaque transport (`Record<string, unknown>`), on the ground that this SDK does not own those shapes and that a second declaration would be free to drift from what the server emits. That ground was correct, and it has not changed. What changed is that the standard now declares both artifacts and publishes the declarations, so the SDK can hold the same boundary by *importing* the one declaration per language rather than by refusing to say anything. Importing is the stricter of the two: an opaque field lets a consumer cast to whatever it believes the shape to be, with nothing checking the belief, while an imported one fails to compile the moment the belief is wrong.

## What landed

- `src/models.ts` imports `PipeIOContracts` and `InputForm` from `mthds/protocol` and types the two report fields with them. The opaque-transport paragraph in the `PipelexValidationReport` docstring is rewritten: it now names only `bundle_blueprint` and `graph_spec`, states why each stays opaque (their canonical schemas live in the runtime's blueprint models and in `@pipelex/mthds-ui`'s `GraphSpec`, and the standard declares neither), and records that the narrowing supersedes the earlier ruling rather than contradicting it.
- The `mthds` floor moves to `^0.23.0` in `package.json`, matching the published release that carries the two protocol modules. The floor is the only version this item moves.
- `tests/validate-report-types.test.ts` pins the narrowing at compile time, and the mocked validate payload in `tests/client.test.ts` becomes a realistic contract and descriptor pair instead of the placeholder `{ inputs: {}, output: {} }` that could never appear on the wire.
- `docs/architecture.md` gains a "Standard artifacts on the validate report" section under "Wire conventions".

## Calls taken here

- **`InputForm` rather than a hand-written `Record<string, PipeInputFormDescriptor>`.** The ledger item spells the field's type out as the record form. `mthds/protocol` exports `InputForm` as exactly that alias, alongside `PipeIOContracts` for the sibling artifact, so using it makes the two fields symmetric and leaves this package restating nothing at all — not even the keying. The keying invariant the field's docstring used to assert in prose ("keyed exactly like `pipe_io_contracts`") is stated by the standard on both artifact types, which is where it belongs. The types are identical, so nothing about the wire or a consumer's code turns on the choice.
- **The floor keeps the caret form.** The local `bump-mthds` skill describes a published floor as `">=X.Y.Z"`, but this package's `mthds` dependency was already a caret range and the rest of its dependency block is caret-ranged too. Changing the operator would have been an unrelated policy change riding along in a typing PR.
- **A compile-time pin was added rather than left implicit.** Nothing in the existing suite would fail if a later edit widened either field back to a bare record, because the mocked payloads travel through an `unknown`-typed helper and never meet the report type. `expectTypeOf` assertions cost nothing at run time and fail the typecheck that `make check` already runs.
- **No version cut.** Under the program's D-7 every Stage 3 repo lands on `dev` and records its warrant under `## [Unreleased]`; the versions are cut together at the program's release cascade, at Stage 4's opening. The changelog entry is the warrant, and the package version is untouched even though the change is breaking.

## What this item deliberately does not do

- It does not narrow `bundle_blueprint` or `graph_spec`. Both are out of the program's scope, and neither has a declaration in the standard to import — narrowing them would mean writing the second source of truth this change exists to avoid.
- It does not touch `@pipelex/mthds-form`, which is item 3.5 of the same stage and the one Stage 4 waits on: the kernel's `contracts.ts` keeps its predicates and re-exports the standard's types instead of declaring them, and takes `mthds` as a peer dependency.
- It does not change the wire, the routes, or the `views` opt-in. `views` stays a Pipelex-API extension typed in this package, which is the other half of D-1.

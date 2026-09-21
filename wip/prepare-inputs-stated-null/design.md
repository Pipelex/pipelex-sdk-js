---
status: draft
item: L-260921-3e22c6
---

# `prepareInputs` reads a stated `default_pipe_ref: null` as the server's answer, not as silence

## The question

`selectPipeRef` in `src/prepare-inputs.ts` picks the pipe whose descriptor guides the preparation walk. With no explicit `pipe_ref` it reads the validate report's `default_pipe_ref` through `nonEmptyString`, so a **stated** `null` and an **absent** field both become `undefined` and both fall through to the bundle blueprint's `main_pipe` and then to the single declared pipe. The ledger item asks whether that fallthrough should stop at a stated `null`, or whether the leniency is the contract and `pipelex-mcp`'s `validate.ts`, which already stops there, is the side that should move. This document records what the investigation found, proposes the answer, and lays out the change.

## What was found

**The server's `null` is a verdict about the run, not a gap in the report.** `_effective_default_pipe_ref` in `pipelex-api/api/routes/pipelex/validate.py` documents the field as "the qualified ref of the pipe a selector-less run of THIS request would execute". On a `method_ref` request it qualifies the fetched manifest's `main_pipe` against the verdict's own pipe set and returns `None` when the code matches nothing or matches in several domains, with the comment that it "yields None rather than falling through to the closure's declaration: the run would pass the manifest's code and fail". Otherwise it qualifies the primary blueprint's `main_pipe` and returns `None` when no blueprint declares one. The field carries the **run** default on purpose (pipelex-api PR #68, settled on [L-260829-0208c7]): a closure whose domains each declare a `main_pipe` gets a string, the first declaring blueprint's, because that is what `execute` runs.

**A selector-less run is refused in every case the server states `null`.** For a `method_ref` run, `pipelex-api/api/routes/pipelex/pipeline.py` passes `run_request.pipe_code or fetched.main_pipe` to the engine, so an unresolvable manifest code reaches `get_required_entry_pipe` and fails there. For inline contents with no declared `main_pipe`, `pipelex/pipelex/pipeline/pipeline_run_setup.py` raises "No pipe_code provided and no main_pipe found in any of the MTHDS contents." The run route has no single-pipe fallback: a bundle declaring exactly one pipe and no `main_pipe` is refused too.

**The SDK's fallthrough can therefore prepare a pipe the run will not execute, in two ways.**

- *The manifest arm.* `bundle_blueprint` on the report is `select_primary_blueprint`'s pick, the first blueprint declaring a `main_pipe`. When a package's manifest names a pipe the closure lacks, or a bare code that several domains declare, the server states `null`, yet `readBlueprintMainPipeRef` still finds the bundle's own `main_pipe` and preparation walks it. The selector-less run then fails on the manifest's code. This is the case the item was filed on.
- *The single-pipe arm.* When no blueprint declares a `main_pipe`, the blueprint arm agrees with the server, but the single-pipe arm still prepares the only declared pipe. The prepared inputs are the right ones for that pipe, and the harm is smaller, but the caller is handed a success for a request whose selector-less run is refused, and learns so one step later.

In both arms the caller cannot even compensate: `PreparedInputs` carries `inputs` and `uploads` only, so nothing tells the caller which pipe was walked, and there is no ref to hand to the run as `pipe_code`.

**The earlier ruling that null-as-absent was deliberate no longer applies.** Codex raised "respect a null resolved default as authoritative" on pull requests #42 and #43 and it was triaged a false positive twice, recorded on [L-260829-0208c7]. The objection at the time was sound: the field's semantic was undecided, and under the build routes' stricter rule (`null` on "none or several") an authoritative `null` would have made `prepareInputs` refuse closures that `execute` runs happily. pipelex-api then settled the field on the run default, so the "several" closure now yields a string and that premise is gone. [L-260831-7c325d] concluded that the null-as-absent handling "stays correct" on that basis, and it did for the several-main-pipes closure; it did not consider the manifest arm, where the blueprint fallback still names a pipe.

**The other consumers already read the field as three arms.** `pipelex-mcp/src/capabilities/validate.ts`'s `defaultPipeRefOf` returns the stated string, refuses to consult the blueprint behind a stated `null` or any non-string value, and derives from the blueprint only when the field is absent; its `SPEC.md` states the rule under "The entry pipe is the report's `default_pipe_ref`; the blueprint derivation stands only behind an absent field", and its tests pin both the absent-field fallback and the withheld form on a stated `null`. The MCP's `prepare.ts` mirror, written on `feature/Prepare-three-selectors` for [L-260829-dfaed4], copied the SDK's fallthrough instead so that the console and the workshop land on the same pipe, and its comment says the choice belongs to `@pipelex/sdk`. `pipelex-sdk-python/pipelex_sdk/prepare_inputs.py` has the same selection function as this SDK, arm for arm.

**The break reaches almost nobody.** Every caller found that omits `pipe_ref` prepares a bundle with a declared `main_pipe` or a package whose manifest resolves: `pipelex-starter-js`'s PDF action, `pipelex-method-apps`' web app, the `pipelex-integrate` skill references in `pipelex-plugins`, and `pipelex-mcp`'s `mthds_prepare_inputs`. All of those get a string from the server and are untouched. The new refusal reaches only a closure the server says has no entry pipe, where the fallthrough's answer was never the run's.

## The decision

**Option A from the item, proposed for ratification.** A stated `default_pipe_ref: null` is the server answering the question `selectPipeRef` asks, and reading an answer as silence is the defect. `prepareInputs` then always walks the pipe a selector-less run would execute, or refuses and names the candidates, and the SDK, the MCP's validate capability, the MCP's prepare mirror and the Python SDK sit on one rule instead of two that agree only in the common case.

Option B, making `mthds_validate` lenient instead, would have the verdict advertise an input form and a `main_pipe` signature for a pipe the run refuses, which is the concern that put the three-arm rule in `validate.ts`. Option C, declaring the two questions different, leaves the disagreement the item exists to end, and the questions are not different: preparation exists to feed a run.

## The rule

`selectPipeRef` keeps its first arm unchanged: an explicit qualified `pipe_ref` wins, and a bare, alias-qualified or undeclared one is refused as today. Behind it, the resolved default has three arms, discriminated on the field's presence and shape rather than on its truthiness:

- **A non-empty string** is the default and is walked. If the string is not a key of `input_form`, preparation refuses, naming the stated ref and the candidates: the descriptor and the default come from one report keyed by one pipe set, so a mismatch is the report contradicting itself, and falling through would silently prepare another pipe. Today this case falls through.
- **A stated `null`, or any own value that is not a non-empty string,** is the server saying it determined no entry pipe. Preparation refuses with `pipe_ref` required, naming the candidates and saying why: no `main_pipe` is declared, or the package manifest names a pipe the closure does not declare or declares in several domains. Neither the blueprint arm nor the single-pipe arm is consulted behind it. Today both are.
- **An absent field** (`report.default_pipe_ref === undefined`) means the runner predates the field, and only then do the blueprint arm and the single-pipe arm stand, exactly as they do today. A JSON body cannot carry an own property holding `undefined`, and the client hands the parsed body through untouched, so the strict-equality test is the whole absence test, the same reading the MCP makes.

`nonEmptyString` stays for the selectors and for the blueprint read; it is only the default's discriminator that changes, because trimming a stated value into absence is the bug.

## The surface

No public type changes. `PrepareInputsRequest`, `PreparedInputs` and `PipelexValidationReport.default_pipe_ref` (`string | null`, optional) keep their shapes. The refusals are `InputPreparationError`, as every other selection failure is, and each names the qualified candidates so the fix is one line. Proposed wording:

- Stated `null`: "Cannot prepare inputs: the server determined no entry pipe for this method, so a run that names no pipe would not resolve one (no `main_pipe` is declared, or the package manifest names a pipe the closure does not declare or declares in several domains). Pass `pipe_ref`. It declares: demo.first, demo.second."
- Stated ref the descriptor lacks: "Cannot prepare inputs: the validate report names `demo.gone` as the default pipe, but its `input_form` descriptor does not describe it. Pass `pipe_ref`. It declares: demo.first, demo.second."

The existing "no single default pipe" refusal stays for the absent-field path with several pipes and no declared `main_pipe`.

## Also in this change

[L-260831-7c325d] is the same field, the same function and the same page, and it lands here rather than as a second branch:

- The TSDoc on `default_pipe_ref` in `src/models.ts` says `null` "when the closure declares none or several", the build strictness. It becomes the run semantic the server ships, with the three-arm reading as the consumer's contract.
- The v0.17.0 changelog entry mirrors that wording; a changelog is history and is not rewritten, so the new entry states the corrected meaning and names the field's earlier description as the one being corrected.
- `tests/e2e/prepare-inputs.e2e.ts` pins a refusal for `github.com/Pipelex/methods/documents` with no `pipe_ref`, with a comment saying the call succeeds once the field ships. It has shipped, and the case fails against any runner carrying the field, as that item's log records. The case flips to the pass it now is: the manifest's `main_pipe` resolves, the server states `documents.extract_document_text`, and preparation walks it.

## Tests

Unit, in `tests/prepare-inputs.test.ts`, through the existing `makeClient(..., { report })` override:

- A stated `null` beside a blueprint `main_pipe` and two declared pipes refuses, names both pipes, says the server determined no entry pipe, and performs no upload. This is the manifest arm and the case the item was filed on.
- A stated `null` with a single declared pipe refuses: the single-pipe arm does not stand behind a stated `null`.
- A stated `null` with an explicit `pipe_ref` prepares: the explicit arm outranks the default.
- A stated string that `input_form` does not describe refuses, naming the stated ref and the candidates.
- The absent-field cases already pinned keep passing unchanged: the blueprint fallback, the already-qualified blueprint `main_pipe`, the single pipe, and the several-pipes refusal.
- The two existing stated-string cases keep passing: the typed default is walked, and it outranks the blueprint.

Live, in `tests/e2e/prepare-inputs.e2e.ts`: a bundle declaring one pipe and no `main_pipe` is refused with `pipe_ref` required, since a runner carrying the field states `null` for it; today the same bundle prepares. The manifest arm has no live fixture, because it needs a published package whose manifest is broken, and the unit case covers it.

## Documentation

- `docs/input-preparation.md`, "Pipe selection": step 2 becomes the three-arm rule, steps 3 and 4 are stated as standing behind an absent field only, and the "manifest-only `main_pipe` gap" note, which describes the world before the field, is replaced by one sentence saying the field is what closes it.
- `src/models.ts`: the TSDoc above.
- `CHANGELOG.md`, under the next version: a **Changed** entry marked as breaking, stating that a stated `default_pipe_ref: null` now stops the fallthrough and what the caller passes instead, and a **Fixed** entry for the TSDoc.

## Follow-ups in other repos

Filed on the ledger, blocked by this decision, so that the consumers converge once it is ratified and released:

- `pipelex-mcp`: `prepare.ts`'s `selectPipeRef` mirror adopts the same three arms when the `@pipelex/sdk` floor moves, its comment recording the divergence goes, and `SPEC.md`'s prepare-inputs error inventory names the stated-`null` refusal beside the existing "no single default pipe" one. Under this decision `validate.ts` does not move.
- `pipelex-sdk-python`: `_select_pipe_ref` in `prepare_inputs.py` applies the same rule, with the same tests and the same page, so the two SDKs stay arm for arm.

## Considered and left out

**Returning the walked `pipe_ref` on `PreparedInputs`.** Every arm behind an absent field still picks a pipe the caller is not told about, and a returned ref would let the caller pass it to the run as `pipe_code` and make the fallthrough honest wherever it remains. It is additive and cheap, but it is a feature beside this decision rather than part of it, and the MCP's `SPEC.md` already documents that the SDK does not return the resolved default. It is offered here for ratification to take or leave.

**Filing the stated-ref-mismatch as a server bug.** The refusal for a stated ref the descriptor lacks guards a contradiction the server should never produce. If it ever fires live, the item goes to `pipelex-api`, not here.

## Implementation checklist

- [ ] `src/prepare-inputs.ts`: the three-arm default in `selectPipeRef`, with the two new refusals.
- [ ] `src/models.ts`: the `default_pipe_ref` TSDoc.
- [ ] `tests/prepare-inputs.test.ts`: the cases above.
- [ ] `tests/e2e/prepare-inputs.e2e.ts`: flip the `documents` refusal to a pass; add the single-pipe-no-`main_pipe` refusal.
- [ ] `docs/input-preparation.md`: the pipe-selection section.
- [ ] `CHANGELOG.md`: the Changed and Fixed entries.
- [ ] `make check` and `make agent-test` green; `make test-e2e` against api-dev for the two live cases.
- [ ] `/rev`, then the pull request with `Closes L-260921-3e22c6` and `Closes L-260831-7c325d`.

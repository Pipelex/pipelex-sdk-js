# Validate request-option types at the public boundary

**Decision (2026-08-25): a published package validates what crosses its boundary.** When a caller supplies a request option whose type is wrong — a state reachable only from untyped JavaScript, or from Python at runtime where annotations enforce nothing — the client throws `PipelineRequestError`. It never silently drops a value it inspected, and it never forwards a value it knows is malformed. Decided by Louis, settling the question raised by cubic on [PR #34](https://github.com/Pipelex/pipelex-sdk-js/pull/34#discussion_r3847423057), deferred in `wip/pr-34-review-notes.md` §1, and filed to the workspace inbox as `2026-08-24-workspace-sdk-runtime-option-validation.md` (delivered here and removed from the queue, per the inbox contract).

Implementation has not started. This document is the plan and the record of why the decision went this way.

## Why this way

The clients cannot be pure pass-throughs, so "TypeScript/annotations are the contract, drop the runtime checks" was never actually available at zero cost. The emptiness normalization is load-bearing wire behaviour: `method_id: ""` must not be sent, the runner rejects a zero-file bundle, and the "something to run" precondition reads the normalized result. Since the client *must* inspect these values, the only real choice was between inspecting sloppily (the status quo, where a wrong value's fate depends on whether it happens to have a `.length`) and inspecting honestly. Honest inspection is a type check, and once a wrong type is detected the honest outcome is a thrown error — silent drop is the one behaviour that costs a caller a debugging session, and forwarding known garbage just outsources the error to a server `422` with a worse message.

## The rule (destined for `docs/specs/`)

> A protocol client throws `PipelineRequestError` when a caller-supplied request option fails its declared shape. It never silently drops a value it inspected, and never forwards a value it has determined to be malformed. Emptiness normalization (an empty string / empty map / empty array treated as absent) applies only *after* the type check passes; presence-based exclusivity checks are unchanged. Both SDK languages partition wrong values identically: the same wrong value produces the same outcome in `@pipelex/sdk` and `pipelex-sdk`.

The spec paragraph belongs in the workspace `docs/specs/` (it is a statement about what protocol clients guarantee, spanning `mthds-js`, `mthds-python`, and both SDKs), with a conformance link per the spec/conformance pairing rule.

## Current behaviour being replaced (evidence, verified 2026-08-25 — line numbers will drift)

- `pipelex-sdk-js/src/client.ts:1795` — `nonEmptyString` tests `value != null && value.length > 0`. A number or plain object has `undefined` for `.length`, so the value never reaches the wire (`buildHostedRunExtensions`, `client.ts:1779`): alongside another runnable source the run proceeds **silently without the method linkage**; as the sole run source, the drop leaves the "something to run" precondition unsatisfied, so `execute()` / `start()` throw before any request is sent — loudly, but claiming nothing was provided when the caller did pass a `method_id`. A **non-empty array** has a real `.length`, so `method_id: ["mt_1"]` is forwarded and the platform answers `422`. Same helper, opposite outcomes. `bundle_b64` rides the same helper on both the execute and start builders (`client.ts:571`, `client.ts:636`); `files` goes through the sibling `nonEmptyFiles` (`client.ts:1789`); `pipe_code` and `mthds_contents` pass through untouched.
- `pipelex-sdk-python/pipelex_sdk/client.py:1003` — the whole check is `if method_id:`. Plain truthiness drops falsy non-strings (`0`, `[]`, `{}`) and forwards truthy ones (`123`, `["mt_1"]`) to a server `422` — a *different* partition of wrong values than the JS client, for the same argument on the same wire.
- `mthds-js/src/protocol/method_files.ts:88` — `isMethodFileEntry` is the model to copy: a real `typeof` guard on caller-supplied data, throwing `PipelineRequestError` with a shape-stating message. Its neighbour `assertExclusiveRunSources` (`src/protocol/options.ts:110`) keys off presence only; a caller passing `files: 42` clears every check in it.

## Per-option shapes

A blanket string check would be wrong — `files` and `mthds_contents` are legitimately a map and an array. The guard is a per-option family:

| Option | Declared shape (TS / Python) | Guard lives in |
| --- | --- | --- |
| `method_id` | `string` / `str` | the SDKs (hosted extension, not protocol) |
| `bundle_b64` | `string` / `str` | protocol packages |
| `pipe_code` | `string` / `str` | protocol packages |
| `files` | `Record<string, string>` / `dict[str, str]` | protocol packages |
| `mthds_contents` | `string[]` / `list[str]` | protocol packages |

Protocol-level options are guarded in `mthds-js` / `mthds-python` so both SDK families inherit one behaviour; the hosted-only `method_id` is guarded in `pipelex-sdk-js` / `pipelex-sdk-python`, following the same rule and the same error-wording style.

## Implementation order

**Phase 1 — protocol packages.** Add the per-option type guards to `mthds-js` and `mthds-python`, throwing `PipelineRequestError`, wording modelled on `isMethodFileEntry`'s message. `assertExclusiveRunSources` stays presence-based for exclusivity — the type guards run alongside it, not instead of it. Wrong-type test cases in each package assert *throw*, never drop and never wire-forward.

*Checkpoint: protocol packages released — record the released versions here before moving on.*

**Phase 2 — the SDKs.** Bump each SDK's `mthds` floor to the Phase 1 releases (this repo has the `bump-required-versions` skill for that). In `pipelex-sdk-js`, make `nonEmptyString` / `nonEmptyFiles` type-honest: non-nullish non-conforming values throw; nullish and empty still normalize to absent. Add the `method_id` guard. In `pipelex-sdk-python`, replace `if method_id:` with an explicit `is not None` plus `isinstance` check that raises. Wrong-type tests in both, plus changelog entries under `## [Unreleased]`.

*Checkpoint: both SDKs shipped — record versions, then close the loop on the PR #34 thread: one-line reply (`Fixed + <SHA>`) and resolve cubic's thread `discussion_r3847423057`.*

**Phase 3 — spec and conformance.** Write the rule into `docs/specs/` (workspace root), link the verifying conformance test bidirectionally, and run `make check-spec-links` in `conformance/`.

## What does not change

For a correctly typed caller, nothing: `null` / `undefined` / `""` for `method_id` are still treated as absent, an empty `files` map is still not sent, and the presence-based exclusivity contract is untouched. The new throw is reachable only from callers already ignoring the published types. Throwing where the client used to drop is a behaviour change, but under the workspace's no-backward-compatibility policy it needs a changelog line, not a deprecation path.

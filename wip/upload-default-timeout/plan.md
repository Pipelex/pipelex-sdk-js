---
status: active
item: L-260924-8d5bb5
---

# Plan — `uploadWithGrant` bounds its `PUT` by default

Design: [`design.md`](./design.md). This tracker carries the phases, the decisions taken while implementing, and the checkpoint hand-offs. It records what cannot be re-derived from the tree, never whether something is committed, pushed or passing right now.

## Scope

One pull request against `dev` in `pipelex-sdk-js`, from `feature/Upload-default-timeout` in the worktree `_pipelex-sdk-js--upload-default-timeout`, titled `feature/Upload-default-timeout · L-260924-8d5bb5` with `Closes L-260924-8d5bb5` in its body. It adds the default bound and the `timeoutMs` override to `uploadWithGrant`, the `code` field on `UploadTransportError` from both producers, the capped read of storage's error body, the four review-round-4 fixes, and the documents. No version bump: that is the release's business, and the consumers wait for it.

Out of scope, and why: the consumers' deletions are in three other repositories and are three ledger items blocked by this one (Phase 4). The other round-4 and campaign follow-ups (moving `uploadFile` onto a grant, `pipelex-app` adopting grants) are the campaign's "Later" list and are untouched.

## Phase 0 — ratification

- Louis answers the four open questions at the end of `design.md`. The plan below is written against the recommended answers; a different answer changes Phase 1's surface and Phase 4's items.
- On ratification: flip both documents to `status: active`, record the answers and the date under "Decisions log" below, and narrow the item's done condition to the SDK with `ledger` (Decision 7), noting the three consumer items in its log.

## Phase 1 — the helper, the error field, the client fix

Files: `src/errors.ts`, `src/upload-grant.ts`, `src/upload.ts`, `src/client.ts`, `src/index.ts`.

- `src/errors.ts`: the `UploadTransportCode` union (`timeout`, `unreachable`, `server_error`, `storage_timeout`, `conflict`, `redirected`, `invalid_grant_url`, `unexpected`), each value with a one-line comment; `UploadTransportError` gains `code: UploadTransportCode | undefined`, set from a `code` option; its docstring says the SDK sets it on every one it raises, as `RejectedAssetError`'s does.
- `src/upload-grant.ts`:
  - `UploadWithGrantOptions.timeoutMs`, documented with the default formula and the ceiling; validated before anything is sent, after the existing "an abort that came first wins" check, raising `InputPreparationError` for a value that is not a positive finite number or exceeds 2 147 483 647.
  - The default: named constants for the minute and the second per 128 KiB, and a local `defaultTimeoutMs(size)`.
  - The call's own controller, timer and `timedOut` flag, the caller's signal forwarded, both cleared on every way out, covering the request and the error-body read (the `requestRaw` shape in `src/client.ts`).
  - A timeout raises `UploadTransportError` with `code: "timeout"` and a message naming the file, the seconds allowed, the unknown outcome and the same-grant retry advice; a caller's abort still wins and propagates as its reason.
  - `readErrorPrefix(response, maxBytes)`: a reader loop up to 16 KiB, decoded with a non-fatal `TextDecoder`, the rest cancelled, replacing `response.text()`; an aborted read maps to the caller's reason or to the timeout.
  - Every other `UploadTransportError` gets its `code`: `unreachable`, `redirected`, `storage_timeout`, `server_error`, `invalid_grant_url`.
  - The round-4 fixes: the unreachable message adds the unknown-outcome, same-grant retry advice after the CSP hint; `409 ConditionalRequestConflict` becomes `UploadTransportError` with `code: "conflict"` before `classifyRefusal` runs; the `5xx` message trims a trailing period off S3's message.
  - The function's docstring: the bound, the override, and the code on each transport case.
- `src/upload.ts`: the `code` on each of the three `UploadTransportError` sites, per the design (`server_error` from 500 up, else `unexpected`; `timeout` for `ABORT_TIMEOUT`, else `unreachable`; `unexpected` for the last-resort wrap).
- `src/client.ts`: in `requestRaw`'s `catch`, when the call's own controller has aborted and the caller's signal has not, classify from `controller.signal.reason` rather than from the runtime's error, so a timeout during the body read is `ABORT_TIMEOUT` in every runtime.
- `src/index.ts`, and the `@pipelex/sdk/upload` entry: export the `UploadTransportCode` type from both.

Commands: `make check`.

## Phase 2 — tests

Files: `tests/upload-grant.test.ts`, the `uploadFile` suite, the client's request-pipeline suite. Timer cases use Vitest's fake timers with a `fetch` mock that settles only when its signal aborts, and rejects with the signal's reason as a runtime does.

- **The default bound**: with no signal and no `timeoutMs`, a hanging `PUT` rejects with `UploadTransportError`, `code: "timeout"`, at 60 s for an empty file and at 68 s for a 1 MiB one, and not a millisecond before; the message names the seconds; the signal `fetch` received is aborted.
- **The override**: `timeoutMs` shorter and longer than the default replaces it; `0`, a negative, `NaN`, `Infinity` and `2 ** 31` are refused with `InputPreparationError` and `fetch` is never called.
- **The caller's signal**: rewrite "forwards the caller's signal to the PUT" to assert that a caller's abort aborts the request's signal; a caller's abort before the timer fires propagates as its reason; an `AbortSignal.timeout` passed by the caller still propagates as its own `TimeoutError`, unwrapped, since that is the caller's abort; the existing abort cases stay green.
- **No timer is left behind**: `vi.getTimerCount()` is zero after a success, a refusal, a timeout and a caller abort.
- **The timer fires while an error body streams**: the result is the timeout, not a body error.
- **The capped read**: a `403` whose `<Code>` and `<Message>` open a body longer than 16 KiB is classified correctly and the stream is cancelled after the cap; a body whose `<Code>` starts past the cap falls back to the status text.
- **The codes**: every existing `UploadTransportError` case asserts its `code`; the `409 ConditionalRequestConflict` case is new; the unreachable message carries the same-grant advice; a `5xx` whose S3 message ends in a period prints one period.
- **`uploadFile`**: a `503` is `server_error`, a `429` is `unexpected`, an `ApiUnreachableError` with `ABORT_TIMEOUT` is `timeout`, one with `ECONNREFUSED` is `unreachable`, a non-HTTP failure is `unexpected`.
- **`requestRaw`**: the client's timer firing while the body streams, with the body erroring with a generic `AbortError`, yields `ApiUnreachableError` with `code: "ABORT_TIMEOUT"`.
- **The browser entry**: the esbuild bundle test stays green with nothing marked external, which proves the new code added no Node-only import.

Commands: `make check`, `make agent-test`. `make test-e2e` against a hosted platform when a key is available; the upload-grant e2e suite should pass unchanged, since a small file never meets the bound.

## Phase 3 — documentation and changelog

- `docs/input-preparation.md`, "Uploading with a grant": the signature becomes `uploadWithGrant(grant, file, { signal?, timeoutMs? })`; a paragraph on the default bound with its formula and its value at 50 MiB, how a signal shortens it and `timeoutMs` replaces it, and the retry advice after a timeout; the refusal table gains a `code` column for `UploadTransportError`, a timeout row and a `409` row; the paragraph after the table names `UploadTransportError.code` as what a caller branches on and says the error body is read only up to its first 16 KiB.
- `docs/input-preparation.md`, the `uploadFile` error section: `UploadTransportError.code` and its values there.
- `docs/architecture.md`: the `upload-grant.ts` bullet gains the default bound and the code.
- `CHANGELOG.md`, under `## [Unreleased]`: Added (the default bound and `timeoutMs`; `UploadTransportError.code` and the `UploadTransportCode` type); Changed (a `409 ConditionalRequestConflict` is an `UploadTransportError`, no longer a `RejectedAssetError`; storage's error body is read only up to 16 KiB); Fixed (the unreachable message's missing retry advice, the double period, and `ABORT_TIMEOUT` lost in a browser when the client's timeout fires during a body read).

Commands: `make check`.

### Checkpoint — before the pull request

Phases 1 to 3 run in one session, so they share one checkpoint. Record under "Checkpoint log":

- the message wordings as written for the timeout, the conflict and the unreachable case;
- anything the fake-timer tests revealed about the runtime's abort behaviour;
- whether the e2e suite ran, and against which base URL;
- the final exported surface and the changelog entry as written;
- then `/rev` at the depth `ledger review-profile` derives.

## Phase 4 — review, pull request, the consumer items

- The rounds `/rev` still asks for after the checkpoint's pass, then the pull request against `dev`, its body two or three sentences and `Closes L-260924-8d5bb5`.
- File three items, each `--blocked-by L-260924-8d5bb5` and `--discovered-from L-260924-8d5bb5`, titled by outcome, each saying what to delete (`uploadTimeoutMs`, its tests, the `AbortSignal.timeout` argument) and what to branch on instead (`err.code === "timeout"`):
  - owner `pipelex-mcp`: `src/views/run-graph-upload.ts` and its test;
  - owner `pipelex-method-apps`: `webapp-js/src/hooks/useFileInputs.ts`, its test, and `classifyUploadError` in `webapp-js/src/lib/errors.ts`, which can also stop calling a `5xx` or a storage timeout a network drop;
  - owner `pipelex-starter-js`: the same three places in `src/`.
- The item closes when the pull request merges, through `/ledger-land`. The consumers need the release rather than the merge, so when `/release` files the `pipelex-sdk-js` release item that carries this change, that item is added to each consumer item's `blocked_by`, the pattern L-260922-06b7b0 followed with the 0.22.0 release item.

## Decisions log

- **2026-09-24, ratification.** Louis set the goal of carrying the item through to a landed pull request without pausing for questions, which ratifies the four open questions with their recommended answers: the `timeoutMs` override is in scope; `UploadTransportError.code` is set by `uploadFile` as well as `uploadWithGrant`; the four review-round-4 findings are in scope; and the item's done condition is narrowed to the SDK, with the consumers' deletions carried by three items blocked by this one. Decision 7's wording, which said the item closes once the change is also released, was aligned with Phase 4 here: the item closes on the merge, and the release item gates the consumer items.
- **2026-09-24, review round 1 revises Decision 5.** Codex and cubic both found that the time limit running out while storage's error body streams produced a `timeout` with no `status`, telling a caller the outcome was unknown and to retry with the same grant after a `403` that stored nothing. Storage has answered by then, so the call now settles as that answer, classified from its status and the prefix that arrived, and `timeout` means only that no answer came back in time. Keeping the timeout and adding the status was rejected: a consumer branching on `code === "timeout"` would still retry a refusal. The same round made every body cancellation fire-and-forget, since a stream's cancel can outlive any deadline, and extended the timer cap to every entry point that takes a caller's delay (`requestRaw`'s routes, `fetchArtifact`, `downloadArtifacts`, and `waitForResult`'s sleep), a pre-existing gap cubic found, through the new `src/timers.ts`.

## Checkpoint log

### Before the pull request, 2026-09-24

Phases 1 to 3 are done as planned, with two additions and one deviation.

- **The messages as written.** The timeout: `Upload of "<file>" did not finish within the <n> s allowed, so whether storage stored the file is unknown. On a slow link, pass a longer timeoutMs.` followed by the shared same-grant advice, `Retrying with the same grant before it expires at <expires_at> either stores the file or reports the grant as used, and then the grant's uri already names the file.` The conflict: `Upload of "<file>" met another upload with the same grant still in progress at storage (409 ConditionalRequestConflict), so whether the file was stored is unknown. Send a grant once at a time.` and the same advice. The unreachable case keeps its CSP hint and adds `If the connection failed after the file went out, storage may have stored it anyway.` and the same advice. The `5xx` message now reads `…(503 SlowDown): <S3 message without its final period>. Whether the file was stored is unknown.` and the same advice, where it used to end with a shorter retry sentence that named no expiry.
- **What the fake-timer tests showed.** A body stream that the runtime does not error on abort holds a pending `read()` forever unless the reader is cancelled explicitly: with the explicit cancel removed, the "error body never ends" test hangs, while the browser-style stream that errors on abort still passes. Vitest's fake timers do not drive `AbortSignal.timeout`, so the test of a caller's own `AbortSignal.timeout` runs on real timers with a 10 ms signal. Swapping the caller-first order in the helper fails the precedence test, and removing the controller-reason classification in `requestRaw` fails the new `ABORT_TIMEOUT` test, so both tests bite.
- **The e2e run.** `tests/e2e/upload-grant.e2e.ts` and `tests/e2e/prepare-inputs.e2e.ts` passed unchanged against `https://api-dev.pipelex.com` (hosted `0.22.1`), with the api-dev key from `.env`.
- **The exported surface.** `UploadTransportCode` (a type, from the main entry and from `@pipelex/sdk/upload`), `UploadTransportError.code` with a `code` option on its constructor, and `UploadWithGrantOptions.timeoutMs`. Nothing else changed shape.
- **The changelog entry**, under `## [Unreleased]`: Added `UploadTransportError.code` and `UploadTransportCode`; Changed (Breaking) `uploadWithGrant` bounding its `PUT` and taking `timeoutMs`, with the 16 KiB error-body read folded into that bullet, and Changed (Breaking) the `409 ConditionalRequestConflict` becoming an `UploadTransportError`; Fixed the unknown-outcome messages (the unreachable advice and the double period) and `ABORT_TIMEOUT` in a browser. The default bound is marked breaking because a call on a link slower than about 1 Mbit/s that used to succeed with no signal now times out unless it passes `timeoutMs`.
- **Addition: a pre-existing doc error fixed.** `docs/input-preparation.md` listed a malformed data URL payload as an `UploadTransportError`; `decodeDataUrl` in `src/prepare-inputs.ts` raises a plain `InputPreparationError`, and the doc now says so.
- **Addition: the default is capped** at 2147483647 ms, so a file past about 262 GiB cannot overflow the timer.
- **Deviation: `unexpected` from `uploadWithGrant`.** The fall-through after the mapped ranges sets `server_error` only from `500` up and `unexpected` otherwise, rather than calling every leftover status a server error; the design's table was updated to say so.
- **This repository has no `make agent-test` target**, so the gates were `make check` and `make test`.
- Next: `/rev` at the depth `ledger review-profile` derives.

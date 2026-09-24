---
status: active
item: L-260924-8d5bb5
---

# `uploadWithGrant` bounds its `PUT` to storage by default

## Where this comes from

`uploadWithGrant` (`src/upload-grant.ts`, exported from the browser-safe `@pipelex/sdk/upload`) shipped in 0.23.0 for the workspace campaign `wip/run-form-direct-upload/`. Review round 3 of that campaign's SDK phase deferred two findings on it, a missing default timeout and an unbounded read of storage's error body, on the grounds that a caller can bound the call with its own signal. The campaign's design came back to it as Decision D once the consumers had landed: every caller since has passed its own signal, with the same formula copied each time. This document is the `@pipelex/sdk` design for that decision. It is related to the campaign's epic, L-260923-854545, and not a member of it: nothing there waits on it.

## Verification, 2026-09-24

The item's claims hold against `dev` at `63e9ba5`.

- **No default bound.** The `fetch` in `uploadWithGrant` passes the caller's `signal` and nothing else, so a `PUT` that stalls with no caller signal never settles. The client's own routes do not behave this way: `requestRaw` (`src/client.ts`) and `fetchArtifact` (`src/artifacts.ts`) each arm a timer on their own controller and forward the caller's abort into it.
- **An unbounded error-body read.** A non-2xx answer is read with `response.text()` in full before `<Code>` and `<Message>` are picked out of it.
- **The formula is copied, and three times rather than two.** A minute plus a second per started 128 KiB, about 1 Mbit/s, which is 460 s at the 50 MiB cap:
  - `pipelex-mcp/src/views/run-graph-upload.ts`, `uploadTimeoutMs` (on `dev` since `905efd8`);
  - `pipelex-method-apps/webapp-js/src/hooks/useFileInputs.ts:118`, `uploadTimeoutMs`;
  - `pipelex-starter-js/src/hooks/useFileInputs.ts:118`, `uploadTimeoutMs`, which the item did not list. The method-apps template was copied from the starter, so they carry the same code.

Two further facts shape the design.

- **Every consumer branches on the timeout by the error's name.** `pipelex-method-apps` and `pipelex-starter-js` map any `UploadTransportError` to "Could not reach Pipelex storage", then catch `err.name === "TimeoutError"` separately to say "The upload took too long"; `pipelex-mcp` catches `TimeoutError` to say "timed out after N seconds". Once the SDK raises its own timeout as an `UploadTransportError`, a consumer needs a field to tell the timeout from an unreachable host, or its message becomes wrong. The same mapping already mislabels a `5xx` and storage's `400 RequestTimeout` as a network drop, for the same lack of a field.
- **The existing unit test pins the old wiring.** "forwards the caller's signal to the PUT" (`tests/upload-grant.test.ts`) asserts that `fetch` receives the caller's signal itself. Under this design `fetch` receives the helper's own signal, so that test is rewritten to assert that a caller's abort reaches the request.

Review round 4 of the campaign also left four unverified findings on the same function and one on the client. They were checked by reading the code, and all five hold; the design takes them in, because they change the same messages and the same error mapping (Decision 6).

## Decisions

### 1. The default bound, and what it covers

When the caller passes no `timeoutMs`, the bound is **60 s plus 1 s for every started 128 KiB of `file.size`**, the formula all three consumers use. It covers the whole exchange: sending the request, the body going out, the response headers coming back, and the bounded read of an error body. It is the `requestRaw` idiom: an `AbortController` owned by the call, a `setTimeout` that aborts it with a `TimeoutError` `DOMException` and sets a `timedOut` flag, the caller's signal forwarded into it, and the timer and the listener cleared on every way out. The helper stays browser-safe, since all of this is a global in every runtime the entry supports.

`AbortSignal.any([signal, AbortSignal.timeout(ms)])` was the other way to write it, and it was rejected: the timer cannot be cleared once the upload settles, and telling which of the two fired needs the flag anyway.

The grant's own expiry does not bound the upload, which is why a client-side bound is needed at all: storage checks the signature when the request starts, not when it ends.

### 2. A caller can shorten the bound with its signal, and replace it with `timeoutMs`

`UploadWithGrantOptions` gains `timeoutMs?: number`, which replaces the default bound. A caller's `signal` stays as it is: it ends the upload whenever it fires, so it can only shorten the bound.

The override is what keeps the change from taking something away. Today a caller on a link slower than about 1 Mbit/s can upload a 50 MiB file by passing no signal; with a default bound and no override, nothing could lift it. `fetchArtifact` already takes a `timeoutMs` beside its `signal`, so the pair reads the same on both sides of storage.

`timeoutMs` must be a positive finite number no larger than 2 147 483 647, the largest delay `setTimeout` honours; a larger one overflows and fires at once in both Node and browsers. Anything else is refused with an `InputPreparationError` naming the option, before anything is sent. That is `requirePositive` in `src/artifacts.ts`, rewritten locally, because the browser-safe entry cannot import `artifacts.ts`.

### 3. The timeout is an `UploadTransportError` whose `code` is `timeout`

`UploadTransportError` gains `code: UploadTransportCode | undefined`, the twin of `RejectedAssetError.code`, set by the SDK on every `UploadTransportError` it raises, from `uploadWithGrant` and `uploadFile` alike. It is undefined only on one a caller constructs without it.

| `code` | Raised by | Meaning | Was anything stored? |
| --- | --- | --- | --- |
| `timeout` | both | The SDK's own bound elapsed first: `uploadWithGrant`'s, or the client's request timeout under `uploadFile`. | Unknown |
| `unreachable` | both | No response reached the SDK. In a browser, a refused cross-origin request looks like this. | Unknown for `uploadWithGrant` once the body was sent (Decision 6) |
| `server_error` | both | A `5xx`. | Unknown |
| `storage_timeout` | `uploadWithGrant` | Storage's `400 RequestTimeout`: it stopped waiting for the body. | No |
| `conflict` | `uploadWithGrant` | Storage's `409 ConditionalRequestConflict`: another `PUT` with the same grant was in flight (Decision 6). | Unknown |
| `redirected` | `uploadWithGrant` | A redirect, refused rather than followed. | No |
| `invalid_grant_url` | `uploadWithGrant` | The grant's `url` is not an absolute `http(s)` URL free of user info, so nothing was sent. | No |
| `unexpected` | both | A status or a failure the SDK has no specific mapping for. From `uploadWithGrant`, only a status outside every range it maps, which `fetch` does not produce in practice. | Unknown |

The timeout's message names the file and the time allowed in seconds, says that whether storage stored the file is unknown, and gives the same advice as a `5xx`: retrying with the same grant before it expires either stores the file or answers the `412` of a used grant, and then the grant's `uri` already names it. It carries no `cause` and no grant URL, like every error the helper raises.

A field was chosen over a subclass (`UploadTimeoutError extends UploadTransportError`) because the consumers need to tell every transport case apart, not only this one, and a field is how `RejectedAssetError` already does it. A `timeoutMs` field on the error was left out: no consumer needs the number except to print it, and the message prints it.

`uploadFile` sets the codes from what it already has: a status of 500 or above is `server_error`, any other status reaching its `default` arm is `unexpected`, an `ApiUnreachableError` whose `code` is `ABORT_TIMEOUT` is `timeout`, any other `ApiUnreachableError` is `unreachable`, and the last-resort wrap is `unexpected`.

### 4. A caller's abort still wins, unwrapped

Nothing changes for a caller that aborts. When the caller's signal has fired, the helper rejects with that signal's `reason`, never wrapped and never turned into a timeout, whether the abort lands before the request, during it, or while an error body streams. When both have fired, the caller's abort wins, because it is the one the caller can see and act on. The existing tests for this stay and gain the case of an abort landing after the helper's own timer has been armed.

### 5. Storage's error body is read up to a cap

The error body is read from `response.body` through a reader, **at most 16 KiB**, then decoded with a non-fatal `TextDecoder`, and the rest of the stream is cancelled. S3 writes `<Code>` and `<Message>` first in its error document, so only the prefix is needed; the longest document this helper meets, a `SignatureDoesNotMatch` that echoes the canonical request and the string to sign along with their bytes in hex, runs to several kilobytes after them. A body cut before `<Code>` closes falls back to the status text, as a body that is not S3's already does. The read stays under the bound of Decision 1. A caller's abort during the read propagates as the caller's reason. The helper's timer firing during the read is not a timeout: storage has already answered, so its status says what happened, and the call settles as that answer, classified from whatever part of the body arrived (revised in review round 1; see the plan's decisions log). The rest of the body is cancelled without awaiting the cancellation, which a stream can hold open past any deadline. The body is never kept, as today.

### 6. The review-round-4 findings on the same code are taken in

Each was checked by reading the code on 2026-09-24.

- **A network failure after the body left is an unknown outcome.** When `fetch` rejects with neither abort having fired, storage may already have written the object, but the message says only "could not reach storage". A caller that requests a new grant then may store the file twice. The message keeps the CSP hint and adds the same-grant retry advice of a `5xx`.
- **`409 ConditionalRequestConflict` is a transport failure, not a refusal.** S3 answers it when two create-only `PUT`s for one key overlap, and documents it as retryable. Today it falls into `store_refused` as a `RejectedAssetError`, whose advice is to request a new grant. It becomes an `UploadTransportError` with `code: "conflict"` and the same-grant retry advice. Sending one grant twice at once is outside the helper's contract, so this only matters to a caller that already misuses it, but the advice it gets today is wrong.
- **The `5xx` message prints a double period** when S3's `<Message>` already ends with one, as `InternalError`'s does. A trailing period is trimmed before the retry advice is appended.
- **The client's own timeout firing while a response body streams is misclassified in a browser.** `requestRaw` classifies the failure from the runtime's error, and Chrome and Firefox error the body stream with a generic `AbortError` rather than the controller's reason, so the result is an `ApiUnreachableError` with no `code` instead of `ABORT_TIMEOUT`. `fetchArtifact` avoids this with its `timedOut` flag. `requestRaw` will classify from `controller.signal.reason` whenever its own controller has aborted and the caller's has not. This is in `client.ts`, not the upload helper, and it is taken in because Decision 3 maps `ABORT_TIMEOUT` to `code: "timeout"` for `uploadFile`, which would otherwise be wrong in a browser.

### 7. The consumers delete their copy after the release

Three consumers bound the call with the copied formula: `pipelex-mcp`, `pipelex-method-apps` and `pipelex-starter-js`. Once a release carries this change, each bumps `@pipelex/sdk`, stops passing `AbortSignal.timeout`, deletes `uploadTimeoutMs` and its tests, and branches on `err.code === "timeout"` instead of `err.name === "TimeoutError"`. `pipelex-method-apps` and `pipelex-starter-js` can also stop calling a `5xx` or storage's `RequestTimeout` a network drop, now that the code tells them apart. That work is in their repositories, so it is three ledger items, each blocked by this one.

The item as filed makes the consumers' deletions part of its own done condition. That condition is narrowed to the SDK: this item closes when the change is merged with its documentation, and the three consumer items carry the rest. The consumers need a published version rather than the merge, so each consumer item is also blocked by the release item that carries this change, once `/release` files it.

## Rejected

- **Leaving the bound to callers**, the round-3 position. Three copies of one formula and three hand-written timeout branches are the evidence against it.
- **A bound without an override.** It would turn the default into a ceiling that no caller could lift (Decision 2).
- **A fixed bound independent of the file's size.** It would be too short for a large file or far too long for a small one; the size-scaled formula is the one every consumer already chose.
- **Exporting the formula as a function.** No consumer needs it once the default applies, and the docs state it.
- **`AbortSignal.any` with `AbortSignal.timeout`** (Decision 1).

## Open questions for ratification

Each has a recommended answer, and the plan is written against it. All four were ratified with their recommended answers on 2026-09-24 (see the plan's decisions log).

1. **Is the `timeoutMs` override in scope?** Recommended: yes, for the reason in Decision 2. Without it the change removes the ability to upload a large file on a slow link.
2. **Should `UploadTransportError.code` cover `uploadFile` too?** Recommended: yes, so that the field holds the same promise `RejectedAssetError.code` does, set on every error the SDK raises. The alternative is a field set by `uploadWithGrant` only, which a consumer of both would have to learn twice.
3. **Are the round-4 findings (Decision 6) in scope?** Recommended: yes, all four. Three change the messages and mapping this change rewrites anyway, and the fourth decides whether `uploadFile`'s new `timeout` code is right in a browser.
4. **Is the item's done condition narrowed to the SDK, with three consumer items filed and blocked by it?** Recommended: yes (Decision 7).

---
status: active
item: L-260918-58d8a4
---

# Deferred from the review of the artifact stack

Round 3 at profile 4, bar `necessity`, on `feature/Sdk-artifact-stack`, reviewed at `0933892`. Cubic and `code-review` each found real behaviour that the bar does not admit, because nothing the platform stores today can trigger it or because it is a design question rather than a defect. They are recorded here.

## `decodedHeaders` infers from the header what `fetch` did to the body

`src/artifacts.ts` drops `Content-Encoding` and `Content-Length` only when every listed coding is gzip, x-gzip, deflate or br. The inference goes wrong in two ways. First, whether `zstd` is decoded depends on the runtime: Node 22's fetch leaves it encoded, while Node 24's (bundled undici with `zlib.createZstdDecompress`) and recent Chrome decode it, so on those runtimes a decoded body keeps a `zstd` label and the encoded length. Second, undici stops decoding at the first coding it does not recognise, including `identity` and the empty token a trailing comma leaves, so `gzip, identity` or `gzip,` comes back still compressed while the function strips the label. Both reviewers reproduced the Node 24 behaviour against a local server.

Nothing triggers either today: no upload path in the runtime, the platform or the SDKs sets `Content-Encoding` on a stored object, so a presigned GET never carries one. The fix, when a store does, is to decide the decoded set per runtime (feature-detect `zstd` on Node) and to mirror undici's loop exactly (stop at the first unknown token, `identity` and empty included) rather than filter the tokens first. The tests mock `fetch` and cannot see real decoding, so the fix wants one test against a local server.

## Whether one oversized item should stop the rest

`downloadArtifacts` keeps the MCP's rule that an item which would cross `maxTotalBytes` on top of the files already saved ends the call's room, and every item not yet started is skipped. That skips small items after one large refused item even though the room was never used: with a 100-byte cap, a 150-byte item followed by two 10-byte items saves nothing. Round 2 already narrowed the rule so that a refusal against a file still in flight stops nothing else. Whether a refusal on the item's own size should also stop nothing else is a behaviour change the MCP would show once it is thin over this SDK, so it belongs with that member's decision rather than here. The wording "once the files already saved leave no room" in `docs/artifact-download.md` and the comment beside `savedBytes` mean "no room for that item", and should say so plainly when the rule is settled.

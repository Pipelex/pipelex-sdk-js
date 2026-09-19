---
status: active
item: L-260918-11bd8b
---

# Deferred from the review of summarizeUsage

Round 2 at profile 3, bar `defects`, on `feature/Sdk-summarize-usage`, reviewed at `a34656d`, the round-1 fix that rewrote the cost guard's comment. `code-review` found nothing. Cubic found one real gap that is not a defect, so the bar left it, and this is where it waits.

## No test pins the non-numeric `cost` guard

`src/usage.ts:146` sums `record.cost` only when `typeof record.cost === "number"`, and its comment says why: artifacts are relayed unvalidated, so a non-numeric `cost` on a malformed one must count as unrated rather than turn the sum into string concatenation. No case in `tests/usage.test.ts` feeds a non-numeric cost. Every existing case (an absent key, `null`, an empty record) behaves the same under `!= null`, and `cost` is typed `number | null`, so a refactor to `!= null` would type-check and pass the suite while breaking the documented behaviour. The fix is one case, `{ cost: "0.02" } as unknown as TokensUsageRecord`, asserting that the record counts as unrated and the total stays numeric. Take it with the next change to `src/usage.ts`.

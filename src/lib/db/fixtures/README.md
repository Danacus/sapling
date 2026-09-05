# Golden fixtures

One directory per scenario. `events.json` is the input: rows exactly as they
would arrive off sync (`seq` included), plus a `meta` block. `expected.json` is
the blessed output: what every read method on the `Backend` returns after the
log is applied. `golden.test.ts` discovers every directory here.

The files are language-neutral on purpose. Another implementation of `core.ts`
must reproduce every `expected.json` from its `events.json` before it may
replace this one.

## `meta`

- `deviceId` — the device the backend is opened as. The replay path never
  mints events, so it does not affect the reads; it is here for a future core.
- `now` — what the core's clock answers. Pinned so `exportedAt` is stable.
- `orderFree` — whether every rule the log exercises is arrival-order
  independent. When `true`, the test also applies the rows in reverse and
  expects identical reads. When `false`, `note` says which rule is not:
  a serve or report before its `challengeAdded`, and a `reviewAmended` before
  the review it replaces, both depend on log order.

## How the reads are probed

Reads are always taken under `TZ=UTC` (`daily` buckets by local day).

- No-argument reads are recorded as returned.
- `getAllItems` is recorded twice, as `lean` and `withRecentGrades`.
- `getItem`, `getText`, `getConversation` are called once per id the log
  mentions for that kind (added, reviewed, updated, deleted, looked up, turned),
  and recorded as a map from id to result; a missing row is `null`.
- `getChallengesByIds` is called once with every challenge id the log mentions.
- `recentResults` uses limit 5; `pendingEvents` uses limit 100.
- `exportData` is recorded parsed, not as the string.
- Reads the protocol leaves unordered — `getAllItems`, `getPool`,
  `getChallengesByIds`, `getKnownTerms` — are sorted by id or term in code-unit
  order before recording. Ordered reads are recorded as returned, so fixtures
  avoid ties in their sort keys (`createdAt`, `at`).

## Fixtures

- `broad` — every event type once, one device. Six pool challenge types plus
  one of an unknown type that must stay in the log and out of the pool; a
  re-graded review; a reported challenge; results either side of midnight UTC;
  texts with YouTube and file media; a word marked then unmarked; a deleted
  conversation.
- `two-devices-lww` — profile and word marks from two devices, the newer copy
  arriving first for half of them; reviews from two devices landing out of time
  order, so the card must fold the same whichever arrives first.
- `item-updates-lww` — two devices patching the same items, newest `at` winning
  per field in both arrival orders: a later patch that leaves `meaning` alone
  does not erase an earlier one that set it, and a patch that arrives before
  its add waits in the log until the item lands.
- `tombstones-first` — deletes that arrive before the add they delete, for an
  item, a text and a conversation; a review and a conversation turn that
  arrive before their parent and count once it lands.
- `stale-and-duplicate-reviews` — a review older than one already folded (a
  refold), the same review under a fresh event id (a legacy import), the same
  event redelivered, and a review of an item the log never adds.

Every fixture also checks that applying the log twice reads the same, that an
export imported into a fresh backend reads the same, and that the exported log
equals the input log field for field.

## Reblessing

```sh
pnpm golden:update
```

rewrites every `expected.json` from the current core. Only do it after a
deliberate change to the merge rules or a read; the diff is the review.

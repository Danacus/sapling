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

Reads are always taken under `TZ=UTC` (`getDailyActivity` buckets by local day).

- No-argument reads are recorded as returned.
- `getAllItems` is recorded twice, as `lean` and `withRecentGrades`. Both — and
  `getItem` — carry `srs`, the schedule the core derives from the card at read
  time, taken against `meta.now`.
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
- `activity-days` — three UTC days for `getDailyActivity`, each a different
  mix: a drill day (three answers, one per verdict, over two words — one of
  them twice, so `reviewed` counts words), a reading-only day (two lookups and
  the review a lookup files, no answer, so a day exists with `count` 0), and a
  day on which one word was added and nothing else. A review of an item the
  log never adds makes no day: `reviewed` counts only words in the garden,
  which is also what keeps the read arrival-order free around a tombstone.
- `version-skew` — rows this build cannot read: `wordShelved`, a kind only a
  newer build writes, and two `itemAdded` payloads carrying `notes: null`,
  which the schema rejects. All eight rows are in `exportData`, field for
  field; none of them reaches the read model. `item-skewed` is never added, so
  the patch naming it waits in the log; `item-shared` has its unreadable add
  *ahead* of a readable one in log order, so the refold a tied patch triggers
  has to take the base it can read. (`pendingEvents` is `[]` here as in every
  fixture — the rows arrive through `applyRemote` already carrying a `seq`, so
  none is unpushed. The pending side is covered by `core.rs`'s own tests and
  by `sync/run.test.ts`.)

Every fixture also checks that applying the log twice reads the same, that an
export imported into a fresh backend reads the same, and that the exported log
equals the input log field for field.

## Reblessing

```sh
pnpm golden:update
```

rewrites every `expected.json` from the current core. Only do it after a
deliberate change to the merge rules or a read; the diff is the review.

The file is written by the **wasm** build, the one the browser loads. Every
value in it is then matched character for character by both runners, with one
exception: `tests/golden.rs` compares the four numbers that come out of the
`f32` model — a card's `stability` and `difficulty`, and the
`srs.retrievability` and `srs.strength` read off them — with a relative
tolerance of `1e-5`, because the FSRS model computes in `f32` and `exp`/`powf`
differ by an ulp or two between the host's libm and the one wasm links. That is
a difference around the seventh significant digit; anything larger, and
anything at all in another field (`srs.due` included — it is the card's own
`due`, a whole minute), is a finding about the core.

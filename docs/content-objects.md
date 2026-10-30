# Content objects — design

Status: steps 1 (the Worker), 2 (the core and the sync cycle) and 3 (export
v4) of §9 are built. GC (§8) and compaction (§10) are deliberately not built.

The events log is the record of what the learner *did*: words, reviews,
answers, marks. A text's body — every segment of a subtitle track — is
content, not a fact, and today it rides inside `textAdded` for ever: a
`textDeleted` tombstones the row but cannot remove the payload, every paired
device downloads every text ever deleted, and an edit would have to re-emit the
whole document. This design moves bodies out of the log into **immutable
objects addressed by hash**, which events reference.

## 1. The constraint

- The Worker **orders and relays; it never merges and never reads a payload.**
  Nothing below changes that: the server learns owner ids and hashes, never
  what a text is or which revision won.
- The log stays append-only and immutable. **No existing event is rewritten**
  (§7).
- Materializers stay total: a reference to an object this device does not have
  is a state, not an error.

## 2. Objects

An **object** is an immutable byte string — a UTF-8 JSON document — named by
its hash:

```
sha256:<64 lowercase hex>
```

- The hash is over the **exact stored bytes**. Every ingress verifies it: the
  Worker on `PUT`, the client on fetch, import on restore. A mismatch is
  refused, never stored.
- The bytes are the Rust struct serialised by `serde_json` (struct field
  order, no whitespace), so the same content written on two devices hashes the
  same and dedupes. Canonical encoding buys dedup only; integrity comes from
  hashing the bytes, so a future encoding change costs dedup, never
  correctness.
- The prefix names the algorithm; a different one is a new prefix, not a
  migration.
- The field that references an object fixes its schema. The only kind in this
  slice is a text body, `TextContent { segments: Vec<Segment> }`.
- At most **1 MiB** per object (Durable Object SQLite rows cap at 2 MB).

## 3. Events

`textAdded` carries **exactly one** of:

- `segments` — the body inline, as every event written before this design
  does; read exactly as today.
- `content: H` — the body as an object.

A new build writes `content` for every new text. Both shapes are pinned by
golden fixtures, mixed in one log.

`textRevised { textId, content: H }` replaces a text's body. Last write by `at`
wins, ties broken as the other last-write-wins rules break them; a revision of
a tombstoned or unknown text is inert, kept in the log. The title, source,
media and creation time are not revisable here. `reading.md`'s "a text is
immutable" becomes "an object is immutable": anything that points into a text
by position (`studied` spans, cue positions) points into whichever body is
current.

`textDeleted` is unchanged.

All three may arrive wrapped in `profileEvent`, like every other type.

## 4. Ownership metadata

Every event can declare, **on the envelope beside `payload`**, which objects it
makes some entity use and which entity it ends:

| field | meaning |
|---|---|
| `owner` | the entity that uses content: `text:<profileId>:<textId>` |
| `objects` | hashes this event makes `owner` use — one edge each |
| `retire` | an owner that is gone for good (tombstones only) |

| event | `owner` | `objects` | `retire` |
|---|---|---|---|
| `textAdded` with `content` | the text | `[content]` | — |
| `textRevised` | the text | `[content]` | — |
| `textDeleted` | — | — | the text |
| anything else, or inline `textAdded` | — | — | — |

The rule GC will apply (§8): **an object is live while some owner with an edge
to it is not retired.** Edges and retirements are sets, so the picture is the
same whatever order the server receives events in, and however often. An edge
to an owner already retired is dead on arrival. A losing concurrent revision is
just another edge from its owner and goes when the owner does — nobody has to
emit a "drop", which is the case per-object refcounts cannot handle.

**One Rust function derives the fields** from a `RawEvent`
(`sapling_domain::object_refs`, unwrapping `profileEvent`). Nothing writes them
by hand, and they are **not stored locally**: the client computes them at push
time, so the local `events` table and the export format of events are
unchanged. Pull never returns them — every client can derive them itself.

## 5. The Worker

Per room, in the Durable Object's SQLite, beside `events`:

```sql
objects (hash TEXT PRIMARY KEY, bytes TEXT NOT NULL, size INTEGER NOT NULL)
edges   (owner TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (owner, hash))
retired (owner TEXT PRIMARY KEY)
```

Endpoints (same bearer phrase, same room routing as `/push` and `/pull`):

| request | answer |
|---|---|
| `POST /objects/missing` `{ hashes: [H…] }` (≤ 500) | `{ missing: [H…] }` — the ones not stored |
| `PUT /objects/<H>`, body = the bytes | `204`; idempotent. `400` on a malformed hash or a mismatch, `413` over the cap |
| `GET /objects/<H>` | `200` the bytes (`application/json`), or `404` |

`/push` accepts the three optional envelope fields, validates their shape (a
malformed one fails the page with `400`, as a malformed envelope does today)
and records them with `INSERT OR IGNORE` in the same request as the events.
The event row itself is stored exactly as before. The server does not require
an edge's object to be present, and **nothing deletes** in this slice.

## 6. The client

**Local store.** `objects (hash PRIMARY KEY, bytes)` in the core's schema — not
an aggregate (it is not derived from the log, so a rebuild keeps it). Writing a
new text puts its object and appends `textAdded { content }` in one
transaction.

**Materialising.** A text row records its body as inline segments or a content
hash. Reads resolve the body through `objects`; **a text whose current object
is absent is not returned by any read** (library, reader, `clipsFor`,
`cuesFor`) until it arrives. Storing an object makes every text that references
it readable; no rebuild needed.

**Sync cycle** (`sapling-sync`, over new `SyncStore` methods, implemented by
the core for wasm and by `sapling-store` natively):

1. *Before each push page:* derive the page's hashes with `object_refs`, ask
   `POST /objects/missing`, `PUT` each missing one from the local store, then
   push the page with the envelope fields. Blobs land before the events that
   reference them.
2. *After pulling:* fetch every object a text row references that the local
   store lacks (`GET`, verify, store). A failed fetch is an outcome, retried by
   the next cycle — the missing set is re-derived from the texts, never queued.
3. A relay without the object endpoints (`404` on `/objects/missing`) fails the
   cycle with its own outcome; the client never pushes a page that references
   objects to a relay that cannot hold them.

**Export v4.** `{ version: 4, …, objects: { H: bytes } }` with every object
some exported event references (`object_refs` over the whole log, every
profile), held locally — one this device lacks is left out, for sync to fetch
later. Import verifies each hash and refuses the whole file on a mismatch,
writing nothing; otherwise the objects land in the events' transaction, so the
texts read at once. v3 files import as before.

## 7. Migration: none

Old `textAdded` events keep their inline `segments` and read as they always
have. Only new writes use objects. Consequences:

- Old texts can still be revised (an edge from them to the new hash) and
  deleted (`retire`); the rules do not care how a text began.
- Old events own no objects, so the server needs **no backfill** of edges.
- A device on an older build skips `textAdded { content }` and `textRevised`
  — an unparsable payload costs the rule, not the row — and `rebuild()`
  applies them once it upgrades. Until then the new texts are missing there.
- Older builds never write object references, so mixed versions can only
  **leak**: an old build deleting a text a new build revised sends no
  `retire`, and that object is never collected. Never a lost body.

The inline bodies already in the log, deleted ones included, stay. The bloat
stops growing; it is not reclaimed (§10).

## 8. Garbage collection (not built)

When it is built, on either side: **delete only an object with at least one
edge, every owner of which is retired**, after a grace period. An object with
no edges is never deleted — that is the safe side of every gap in §7. Clients
apply the same rule locally, from the same function.

## 9. Rollout

Each step deploys alone, Worker first.

1. **Worker** — §5: the three tables, the object endpoints, the optional
   envelope fields on `/push`. Old clients are unaffected.
2. **Core** — §2–§4 and §6 minus export: the hash, `TextContent`,
   `textAdded { content }`, `textRevised`, `object_refs`, the local `objects`
   table, materialising and reads, the sync cycle. Golden fixtures for a mixed
   log and a concurrent revise/delete.
3. **Export v4** — §6.
4. Later: an editing UI, then GC (§8).

## 10. Compaction (only if measured)

Reclaiming the old inline bodies means rewriting the log — inline bodies to
objects, deleted texts dropped — into a new room, and every device's own copy
with it, since an uncompacted device or an old export would push the old rows
straight back. That is a coordinated cutover against the log's immutability
contract, so it waits on a number: the share of an export's bytes in
`textAdded` payloads. If it is ever worth doing, it is general log compaction
(reviews and results too), not part of this design.

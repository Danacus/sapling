# Challenge difficulty

The contracts are `.claude/rules/challenges.md`, `session.md` and `data.md`.
The model is `crates/sapling-challenges`' `ratings.rs`; serving is
`stream.rs`, writing `topup.rs`, the stored numbers `sapling-db`'s
`learned.rs`.

## 1. The job

FSRS decides which word comes up. Difficulty decides two things after that:

- **Serving**: which of the word's challenges it gets, at which help level.
- **Writing**: which kinds new challenges for upcoming words are written as.

Both need one estimate — the chance the learner answers a challenge right —
and both pick what lands nearest the **target**, the chance the learner's aim
asks for.

## 2. Words used here

- **Help level** — one version of the same stored challenge with more or less
  help on screen: a cloze with 4 choices, with 6, or typed (§5).
- **Rating** — a learned number with a **margin**, how sure it is.
- **Target** — the chance of a right answer serving aims at: 90% for Easier,
  80% for Normal, 70% for Harder (the profile's aim).

## 3. Ratings

The chance of a right answer is

```
chance = sigmoid(word − challenge − slope × (length − middle))
```

- **The word side** is read off FSRS's stability, with no number per word:
  `scale · ln(1 + stability) + base`, two ratings every word shares. FSRS
  already holds a number per word, so words need no second system. A
  challenge about several words uses their average.
- **The challenge side** is one rating per kind and help level ("cloze ·
  typed", "multiple choice · reading hidden"). Nothing is written per kind: a
  new kind starts where every other did.
- **Length**: each kind has a slope, how much harder each word above the
  middle of its length range makes it. A challenge is judged at the length it
  was asked to be written at, or, for a row from before that was recorded,
  its measured shape.

An even match is 50%; a word two points above its challenge about 88%.

## 4. Margins and learning

Every rating starts at its starting value with its starting margin
(`data/model.json`, §8). After each answer every rating in it moves by
Glicko-1's step: by how surprising the answer was, more when its own margin
is wide, less when the rest of the match is unsure. Answers shrink a margin.

A challenge rating's margin widens again with days unanswered, by `widen`
(margin² per day), never past where it started. The scale, the base and the
slopes are moved by every answer, so they never widen.

The outcome is 1 for right, 0.5 for almost, 0 for wrong.

## 5. Help levels

Each kind has a short fixed list of help levels, chosen from what the stored
row has:

| Kind | Help levels, easiest first |
|---|---|
| Multiple choice (all three) | one |
| Translate | one |
| Spot the error | one |
| Cloze, cue-cloze | pick from 4 with hint · pick from 6 · type it |
| Multi-cloze | bank of just the answers · answers + 2 extra |
| Word order | sentence tiles only · + 2 extra tiles |

A language with a reading (pinyin, kana) adds **reading hidden** at the
hardest step, within what the readings setting allows (`off` hides it at
every step, `on` never does). Listening is one more level for the kinds that
can be heard, when the device can speak. Each level has its own rating.

## 6. Serving: roll, then pick

Among the head word's **available** challenges at every help level, roll each
challenge rating once within its margin — a normal draw, the rating's value
plus its margin times the draw — and serve the one whose rolled chance is
nearest the target. A tie (two rows of one kind at one length) goes to the
row never served, newest first, then the one served longest ago.

A rating that is well known rolls close to itself, so it is taken only when
it really fits. One that is unsure rolls wide, so now and then it rolls into
reach, is served, and its answer corrects it. That is the only exploration,
and variety comes from it too.

**Available** is one predicate: playable (not reported, every word still
there), an active kind, answered fewer than three times, not shown this
stream, and rested three days or the word is due. Fit never makes a challenge
unavailable; it only orders them.

**The roll is seeded per stream position**: the stream's seed plus the
number of challenges it has served. A peek and the pick, and a pick after a
wait or a refill, roll alike until one is served.

## 7. Writing

Writing keeps a small **stock** per upcoming word: a word with fewer than two
available challenges gets two written. The kinds are the two the same roll
puts nearest the target — each kind judged by its written help level nearest
the target, at the middle of its lengths — and each is written at that middle
length, `short + (long − short) / 2`.

- A **local kind** (cue-cloze) is a candidate only for a word with a usable
  cue. One nothing could be built for is handed on as the model-written kind
  the same roll puts nearest, among those not already asked for that word.
- The model is told the length only. It still writes every help the
  challenge could need (full bank, extra tiles, hint, readings).
- **The stored challenge records the length it was asked for**, and is judged
  at that, whatever length the model wrote.

## 8. The numbers

`crates/sapling-challenges/data/model.json`:

| Number | What it means | Value |
|---|---|---|
| `targets` | The chance each aim serves towards | 0.90 / 0.80 / 0.70 |
| `wordStart`, `wordMargin` | The base's start and margin: where every word sits above a new kind | 0.5, 0.5 |
| `scaleStart` | The stability scale's start and margin | 0.5, 0.5 |
| `challengeMargin` | A kind and help level's margin at the start (its value starts at 0) | 1.5 |
| `slopeStart` | Each kind's length slope's start and margin | 0.1, 0.1 |
| `widen` | What a challenge rating's margin² widens by per day | 0.005 |
| `newWordMemory` | The memory read for a word never reviewed, which FSRS has no curve for | 0.9 |

## 9. Storage and replay

**The answer event records what was shown.** `ChallengeResult.shown` names
the help level; for an older event without it, replay reconstructs it once
from the word's strength at the time.

**An overturned answer counts as answered correctly right away.** When an
escalation agrees a `wrong` answer should have counted, each wrong word's
`Again` review is superseded by a `Good` at the answer's own instant, and a
`resultOverturned` event names the answer by its challenge and `at` and says
what it counts as: `correct`, or `almost` where a gap of a passage was
almost. Replay reads the answer at that verdict, wherever the overturn sits
in the log. The result row keeps what was answered.

**The ratings are derived data**, like FSRS card state: one row per rating in
`difficultyParts` — its value, margin, starting margin, last answer and
answer count. They are folded from the answers in `(at, id)` order, each
word's stability read from its card at the answer. The newest answer is
learned on the spot; anything that could change an answer already folded
marks the fold dirty and the transaction replays every answer once.

**Changing the model or a starting value is a rebuild, not a
reinterpretation**: bump `DERIVED_SCHEMA_VERSION` and every rating is
replayed from the answers. The pool rows never change.

## 10. Streaming

Practice is one continuous stream that runs until the learner stops:

- **Next challenge:** the head of the list — the most urgent word and its
  pick (§6). While the head has nothing and a batch for it is on its way or
  can be started, the screen waits for it. Only when no batch can help — it
  was asked for already, a batch failed or was cancelled, no key, no
  connection — is the head passed, for the first word further down the same
  list with something available.
- **Refill:** a batch is written in the background for the words among the
  next few on the list that are short of stock. How many is the low-water
  mark, which covers the time a batch takes to come back at the learner's
  pace. One batch at a time.
- **After the due words:** words not yet due, soonest first. New words arrive
  only through `add_words`.
- **Each word is asked for once:** the stream remembers the words it has
  asked a batch for until something of theirs is served. A batch that failed
  or was cancelled wrote nothing, so its words are given back.
- **Offline or no key:** when no word in the list has anything and no batch
  can be written, the stream ends, says why, and offers to try again.
- **Pacing:** a free match round after every few early-word challenges.
- **Stopping** is always clean; answers are recorded as they happen.

## 11. Calibrating

The calibration command (`research/`, outside the wasm build) reads the file
the profile page's export writes (`ExportEnvelope`) and replays its answers in
`(at, id)` order through the app's own ratings, predicting each before
learning from it — the same fold `learned.rs` keeps. It prints the number of
answers, log loss and Brier against always guessing the log's own rate, the
calibration bands (predicted against actually right), and every rating at the
end of the log with its margin, answers and days since its last.

```sh
cargo run -p sapling-challenges --bin calibrate -- path/to/export.json [--profile ID] [--search]
```

`--search` scores a small grid of the free numbers (`wordStart`,
`wordMargin`, `challengeMargin`, `widen`) on the same log and prints the best
beside the current; it never writes `data/model.json`.

`--simulated` practises a simulated learner, whose true numbers are known, with
the app's own head pick and refill over its ratings, 60 days of 30 answers, and
reports where the true chance of what was served fell against 0.80 (below,
near, above the 0.70–0.90 band), the mean distance, believed against true
chance, the variety of kinds and levels, why early picks fell short, and per
scenario how fast the ratings followed a change:

```sh
cargo run --release -p sapling-challenges --bin calibrate -- --simulated [--scenario base|trap|growth|new-kind|all] [--seeds N]
```

- **base**: the truth as drawn.
- **trap**: on day 10 every cloze level is believed 2.5 harder than it is.
- **growth**: every hard level eases by 1.5 over the run.
- **new-kind**: cue-cloze becomes writable on day 30, 0.8 easier than cloze.

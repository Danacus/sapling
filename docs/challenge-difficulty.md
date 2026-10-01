# Challenge difficulty — design

Status: **implemented**, all five steps of §13. The contracts are
`.claude/rules/challenges.md`, `session.md` and `data.md`; the calibration
command is §12a.

## 1. Why

Difficulty is decided in four places today, on four different scales:

- **When a challenge is written** — sentence length, gap and tile counts per
  rung (`lessons/*.json` `params`), fixed into the stored row.
- **Whether it may be served** — `kinds.json`'s `demand` and `levels`, the rung
  floors, `demand_for_level`, `served_demand`, `bearable`. Two overlapping gates
  that can disagree.
- **Which one is picked** — `difficulty.json`'s scores, worked out backwards
  from a row's shape, because the row never recorded what it was written for.
- **What the screen shows** — `ladders.json`'s bank sizes, extra tiles, hint
  cut-off, reading and listening odds.

Three problems follow from that:

1. **A word's memory strength is doing two jobs.** FSRS strength decides both
   *when* a word comes back and *how hard* a challenge it gets. How well you
   remember a word is not the same as whether you can produce it in a
   twelve-word sentence.
2. **Nothing learns from answers.** A challenge that is too hard is never found
   out. The only reaction is FSRS lowering the word's strength.
3. **Changing a number reinterprets the whole pool.** A stored row has no
   difficulty of its own, so moving a floor silently changes what every
   existing challenge means.

This design puts difficulty in **one place, on one scale, learned from your
answers**.

## 2. Words used here

- **Skill** — one number per word: how hard a challenge about that word you can
  handle. Learned from answers.
- **Difficulty** — one number per challenge *as shown*: how hard it is. Same
  scale as skill. Learned from answers.
- **Memory** — FSRS's chance that you still remember the word right now
  (retrievability). Unchanged; FSRS keeps owning it.
- **Help level** — one version of the same stored challenge with more or less
  help on screen: a cloze with 4 choices, with 6, or typed. Each help level has
  its own difficulty.
- **Aim** — the success rate we want, for example 80%. The one setting that is
  a matter of taste.

## 3. The model

### Predicting an answer

For a challenge about one word, shown at one help level:

```
chance of a correct answer = memory × sigmoid(skill − difficulty)
```

- **Memory** says whether you remember the word at all. It comes straight from
  FSRS; no new tuning.
- **sigmoid(skill − difficulty)** says whether you can manage *this* challenge,
  given that you remember the word. Equal skill and difficulty is 50/50; skill
  one point higher is about 73%, two points about 88%.

A challenge about several words uses the product of their memories and the
**average** of their skills.

### Learning from an answer

The outcome is 1 for correct, 0.5 for almost, 0 for wrong. The **surprise** is
`outcome − predicted chance`. Then:

```
word skill            += word rate      × surprise   (each word the challenge is about)
shared difficulty part += shared rate    × surprise   (see §3.3)
challenge correction   += challenge rate × surprise
```

A miss the model already expected (low memory, or a hard challenge) is a small
surprise and moves little. A miss on something it thought was easy moves a lot.
A miss that memory explains (a word not seen for months) mostly leaves skill
alone, which is right: you forgot the word, you didn't get worse at sentences.

### What a challenge's difficulty is made of

One learner answers each challenge only a few times, which is far too little to
learn its difficulty from scratch. So difficulty is built from parts, most of
them shared across many challenges:

```
difficulty = type-and-help-level number     (shared: every "cloze, pick from 4")
           + length slope × sentence length (shared per type)
           + challenge correction           (this row only; starts at 0)
```

The shared parts get hundreds of answers and settle quickly. The per-challenge
correction only catches the odd row that is much harder or easier than its
shape suggests (an obscure word in the sentence, a misleading hint).

Every learned number starts from a written-down starting value (§8), so a fresh
install behaves sensibly before any answers exist.

## 4. Help levels

Each type has a **short fixed list** of help levels, chosen from what the
stored row already has. A starting proposal:

| Type | Help levels, easiest first |
|---|---|
| Multiple choice (all three) | one |
| Translate (either direction) | one |
| Spot the error | one |
| Cloze | pick from 4 with hint · pick from 6 · type it |
| Multi-cloze | bank of just the answers · answers + 2 extra |
| Word order | sentence tiles only · + 2 extra tiles |

Languages with a reading (pinyin, kana) add one more dimension for the types
that show it: **reading shown** and **reading hidden**. Listening ("audio only")
is the same, for the types that support it. These are extra help levels on the
same list, not separate settings, and only the combinations listed are used —
not every combination.

Helps are decided by the one check in §5 instead of a ladder per help, so the
bank-size, extra-tile, hint, reading and listening ladders all go away.

## 5. The one check

Serving and refilling ask the **same function**:

```
fits(word, challenge, help level, now) -> predicted chance, if inside the window
```

The **window** is a band around the aim, for example 65–92%. A challenge fits a
word if at least one of its help levels puts the predicted chance inside the
window.

- **Serving** takes the most urgent word (FSRS due first, most overdue first —
  unchanged), and among its rested challenges and their help levels picks the
  one whose predicted chance is closest to the aim. Freshness breaks a tie.
- **Refill** asks, for each upcoming word: is there a rested challenge that
  fits? If not, that word wants one written.

Because both call `fits`, a challenge refill counts as covering a word is
exactly one serving would show, and one serving would never show is never
counted as coverage.

The playable check (not reported, every word still exists) and the rest gap
(`RESERVE_GAP`) stay as they are. They aren't about difficulty.

## 6. Writing new challenges

A request to write a challenge is `{word, type, target difficulty}`, where the
target difficulty is what would put the word at the aim.

- **Type:** the types that can reach the target with some help level and some
  sentence length. Among those, one the word has never had wins, then one it
  has fewest fitting rows of; a draw breaks the tie. Same idea as today.
- **Sentence length:** worked out backwards from the difficulty formula using
  the **middle** help level, then clamped to the type's allowed range. Writing
  at the middle leaves room on both sides: if the word gets weaker the easier
  help level still fits, and if it gets stronger the harder one does. One row
  covers a wider range of skill, which is where the LLM savings come from.
- The model is told the length only. It still writes every help the row could
  need (full bank, extra tiles, hint, readings), as it does today.

## 7. Storage and replay

**The answer event records what was shown.** `ChallengeResult` gains an
optional `shown` field naming the help level. The field is additive, so old
events keep parsing. For old events the help level is reconstructed from the
word's strength at the time through today's ladders, once, during replay.

**Skills and learned numbers are derived data**, like FSRS card state:

- a word-skill column beside the card;
- a challenge-correction column on the pool row;
- one small table of shared numbers (type and help-level numbers, length
  slopes).

The materializer folds `resultLogged` events into them in log order (`seq`),
the same ordering FSRS cards already depend on.

**Changing the model or a starting value means a rebuild, not a
reinterpretation.** Bump `DERIVED_SCHEMA_VERSION` and every skill and
difficulty is replayed from the answers. The pool rows themselves never change.

## 8. Tuning

The numbers are:

| Number | What it means | Starting value |
|---|---|---|
| Aim | Success rate we want | 0.80 |
| Window | Predicted chances allowed | 0.65–0.92 |
| Word rate | How fast a word's skill moves | to be chosen by replay |
| Shared rate | How fast type/help/length numbers move | to be chosen by replay |
| Challenge rate | How fast one row's correction moves | to be chosen by replay |
| Starting skill | A brand-new word's skill | the easiest help level of the easiest type at `newWordChance` (0.9): a word is added where the learner met it, and the first real log showed new words answered right far more often than the aim. It stays under the window's top, so a new word always fits the easiest question |
| Type-and-help starting numbers | One per row of §4's table | from today's `difficulty.json` bases, spread across the help levels |
| Length slope starting values | Per type | from today's `promptWords` scale |

**Tuning is measured, not judged by feel.** A calibration command replays a
copy of the events log and reports:

- how well predictions matched outcomes, as one score (log loss) — lower is
  better;
- a table: of the answers predicted at 70–80%, how many were actually right,
  and so on per band.

Changing a rate or a starting value means running it again and comparing the
score. The command lives in `sapling-challenges` beside the model, runs natively
under `cargo`, and is tested on a fixture log.

## 9. What happens to today's settings

| Today | Becomes |
|---|---|
| `ladders.json` `floors`, `Word::level`, `level_band`, `level_band_centre` | Gone. `srs.strength` stays, for the strength bar only |
| `kinds.json` `demand`, `levels` | Gone. A type is limited only by what its help levels can reach |
| `demand_of`, `served_demand`, `bearable`, `bearable_demand`, `demand_for_level` | Gone |
| `difficulty.json` `bases`, `promptWords`, `multiCloze` weights | Starting values only (§8) |
| `clozeBank`, `multiClozeDistractors`, `wordOrderDistractors`, `hintCeilingLevel` | The help-level lists (§4) |
| `hideReading`, `listeningShare` | Help levels (§4) |
| `matchPairs`, `unsizedMatchPairs` | A fixed round size; rounds become a pacing rule (§11) |
| `lessons/*.json` `params` per rung | One allowed length range per type; the length is chosen per request (§6) |
| `fit`, `first_free` | `fits` (§5) |
| `smooth_demand` | Gone. If jumps still feel bad, a pacing rule on predicted chance |
| `WANT_PER_WORD`, `MAX_TOPUP_WANTS`, `RESERVE_GAP` | Stay (not difficulty) |
| `BATCH_TARGET`, `SESSION_LENGTH` | Stay until streaming, then gone |

## 10. Moving the existing pool

Nothing is thrown away. Existing rows get their type and length from their
stored shape, as `difficulty_of` reads them now, and a correction of 0. Replaying
the answer history (§7) then gives the shared numbers, every word's skill and
every row's correction real evidence from the first run. Rows that turn out
far too hard or easy for every word simply stop fitting and are not served.

## 11. Streaming (after the above)

Sessions are replaced by one continuous stream that runs until you stop:

- **Next challenge:** the most urgent word with a fitting rested challenge,
  through `fits`. The serving rule in §5, one pick at a time.
- **Refill:** when the number of upcoming words with a fitting challenge falls
  below a low-water mark, a batch is written in the background. The mark has to
  cover the time a batch takes to come back, at your answering pace, or the
  stream stalls.
- **After the due words:** words not yet due, soonest first, as the tail of a
  session does today. Whether new words should ever join the stream is out of
  scope; words still arrive only through `add_words`.
- **Offline or no key:** the stream ends when nothing fits, and says so.
- **Pacing:** match rounds after every few early-word challenges, and never two
  near-window-edge challenges in a row if that turns out to matter — rules on
  the stream, not on a plan.
- **Stopping:** stopping is always clean; answers are recorded as they happen,
  as today.

## 12. Decisions

1. **Several words in one challenge.** Implement both the lowest skill and the
   average skill as candidates. The calibration command reports both, and the
   better score on the fixture log is the default. The other stays behind one
   constant so a real-log run can flip it. The first real log (1,620 answers)
   flipped it to **average**: lowest skill on top of multiplied memories
   counted a weak word twice.
2. **Reading and listening are help levels** (§4), picked by `fits`, not user
   settings. The existing romanization-mode setting stays as an upper bound: if
   the learner turned readings off, no help level shows them. Listening help
   levels exist only when audio is available, and a failed audio load falls back
   to the same challenge with its text shown (sound never blocks play).
3. **No learner-wide sentence level.** Add it only if calibration on a real log
   shows long sentences are misjudged for words the learner knows well.
4. **The aim is a profile setting**: Easier / Normal / Harder, mapping to 88%,
   80% and 70%, Normal by default. The window moves with it (aim −15 to aim
   +12 points). It is an additive optional field on the profile, so old
   profiles read as Normal. A change takes effect on the next pick; nothing is
   rebuilt.
5. **Rates are chosen on a simulated learner first.** The calibration command
   also runs against a simulated learner with known skills and difficulties,
   which is what the tests use and what picks the starting rates. The learner
   then runs it on a real export (§8) and adjusts.

## 12a. Calibrating on a real history

The calibration command reads the file the profile page's export writes
(`ExportEnvelope`), so no new export path is needed:

```sh
cargo run -p sapling-challenges --bin calibrate -- path/to/export.json
```

## 13. Build order

1. **Record what was shown.** The additive `shown` field on answer events, first
   and on its own, so evidence starts piling up now.
2. **The model and the calibration command** in `sapling-challenges`, pure
   functions, run over a replayed log. No behaviour change yet.
3. **Derived skill and difficulty** in the materializer, behind a
   `DERIVED_SCHEMA_VERSION` bump.
4. **Serving and refill switch to `fits`.** The rung, tier and ladder machinery
   in §9 is deleted in the same change, along with the rules in
   `.claude/rules/session.md` and `challenges.md` that describe it.
5. **Streaming** (§11).

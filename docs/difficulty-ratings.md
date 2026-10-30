# Difficulty by ratings — design

Status: a prototype beside `docs/challenge-difficulty.md`'s model, scored by
`calibrate`; nothing in the app uses it yet.

## 1. The job

FSRS decides which word comes up. This decides two things after that:

- **Serving**: which of the word's challenges it gets, at which help level.
- **Writing**: which types new challenges for upcoming words are.

Both need one estimate, the chance the learner answers a challenge right, and
both pick what lands nearest the **target**: 80% (`data/model.json`, per aim,
so changing it is one number).

## 2. Ratings

- Every **word** has a rating: how well the learner can use it.
- Every **challenge type at a help level** ("cloze · typed", "multiple
  choice · reading hidden") has a rating: how hard it is.
- The chance of a right answer is `sigmoid(word − challenge)`: an even match
  is 50%, a word two points above its challenge about 88%.
- After an answer both ratings move, by how surprising it was: a success at
  50% moves them far, a success at 95% hardly at all.

A challenge about several words uses their average rating.

## 3. Margins

Each rating has a **margin**, how sure it is. Answers shrink it; time without
answers widens it again, back to the starting margin at most. A rating with a
wide margin also moves more per answer — it has less to lose.

Every rating starts the same way: a word at the same rating and margin as
every other new word, a challenge type at the same rating and margin as every
other. Nothing is written per type, so a new type needs no numbers.

## 4. Choosing: roll, then pick

To serve a word, roll each of its available challenges' ratings within their
margins and take the one whose rolled chance is nearest the target. A rating
that is well known rolls close to itself, so it is taken only when it really
fits. One that is unsure rolls wide, so now and then it rolls into reach, is
served, and its answer corrects it. That is the only exploration; variety
comes from it too.

Available is: playable, answered fewer than `MAX_SERVES` times, rested or the
word is due, not shown this stream. Fit never makes a challenge unavailable;
it only orders them.

Writing keeps a small **stock** per upcoming word: when a word has fewer than
two available challenges, write two, each type chosen by the same roll.

## 5. Where a word's rating comes from

From FSRS's stability, with no number per word: `scale · ln(1 + stability)
+ base`, two numbers every word shares. A rating of its own per word predicted
the learner's export only slightly better, and FSRS already holds a number per
word, so words need no second system. FSRS grades every right answer alike, so
this cannot tell an easy success from a hard one; the challenge ratings carry
that.

## 6. Sentence length, and what is left out

Sentence length is in: each type has a slope, how much harder each word above
the middle of its lengths makes it. It is the one extra that predicted
clearly better.

Left out until the numbers ask for it: a correction per challenge, FSRS
memory at answer time, ordered help levels, joint uncertainty between
ratings. Each is added only if
`calibrate` shows it is worth what it costs to explain.

## 7. Scoring

`calibrate` on a real export (prediction: log loss, calibration by band) and
in closed-loop simulation against learners whose true numbers are known
(picks near the target, how fast a mis-rated type is served again, a new type
entering, a fresh install's first weeks), always against the current model
and the round-2 prototype (`model_v2.rs`).

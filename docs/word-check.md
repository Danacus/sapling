# Check what you know

A quick way to build a base vocabulary: the learner taps the words they already recognise in a grid, and those become ordinary cards. Route `src/routes/explore/check/`, reached three ways:

- **Onboarding's last step**, "How much {target} do you know?" (`src/routes/onboarding/`, its branching in `steps.ts`): *Starting from scratch* saves the profile and opens `?mode=starter`; *I know some already* opens the check. The step exists only when there is a model to write the grid — a key typed on the model step, the stored key when adding a language (`?add`, which has no key step), or the `ll.mockMode` flag set explicitly (`isMockForced`). Without one, onboarding ends on the dashboard.
- **The home screen's empty-library hero**, when a model can write words (a key, or the forced mock). With neither, the hero says so instead — *Add a model key to generate your first words*, linking to the key field in Settings, with *or import a text* → `/read` — rather than opening a check that cannot fetch a grid.
- **Explore's first door.**

A first run that ends with nothing added is fine: the home hero offers the check again.

## What it is not

Deliberately dumb. There is **no frequency rank, no vocabulary-size estimate, no new stored state and no new event**. A grid is whatever the model proposes; the only signal that steers the next one is the share of this one the learner tapped. A tapped word is handed to `addWords` (`$lib/assistant`), the same `add_words` executor every other route by which a word enters the garden uses, so it is a fresh card like any other, deduplicated by card the same way.

## Two modes, one screen

- **Check** (`/explore/check`): an intro, then grids of up to `GRID_SIZE` (20) tiles. A tile shows the term and its reading, if any; tapping selects it and reveals its meaning, so a learner who guessed wrong can untap. **Next** adds the selected words and fetches the next grid; **Done** adds them and shows a summary (`N words added`, *Practice now* → `/learn`, *Back to Explore*).
- **Starter** (`/explore/check?mode=starter`): pick a topic (preset chips or free text), then one grid of `STARTER_COUNT` (12) words around it, **all pre-selected**. **Add these** adds the selected and finishes; **More on this topic** adds the selected and fetches another grid on the same topic.

**Words are added at every step forward**, never batched to the end, so leaving at any moment keeps everything already moved past. A word sent is locked on its tile, so a retry after a failed fetch only fetches. A running "N added" counts what `add_words` reports it actually added.

## The step rule (`check.ts`' `nextStep`)

After each check grid: tapped ≥ 70% → `harder`, < 30% → `easier`, otherwise `same`. An empty grid says nothing and stays `same`.

**How a run opens** (`firstCheck`). With an empty library the first grid is `start` (the very most common everyday words) with an empty `recent`. With words already in the library, `start` would propose the common words the learner mostly has and the filter would drop nearly all of them, so the run opens at `same` instead, with the latest-added library terms (up to 60, by `introducedAt`) as the seed of `recent`: "about as hard as what I last added, none of these". The seed stays ahead of the shown words in `recent` for the rest of the run, and is pushed out as the run shows more. Still no estimate: the newest cards are just the reference point. A starter grid is about its topic and sends no seed.

## The repeat filter (`check.ts`' `freshWords`, `fetchGrid`)

The client's, never the model's. Every proposed word is dropped if it is the same card (`sameCard`, `add_words`' own rule) as anything in the library or anything already shown this run, or a repeat within the batch; the first survivors fill the grid. Fewer than `MIN_GRID` (8) survivors and the grid is fetched **once** more, with the first reply's words added to `recent`, before showing — never a third time, so a model that keeps repeating itself yields a short grid rather than a loop, and a grid with nothing new is an error the learner can retry.

## The call

`wordBatch` (`crates/sapling-llm/src/word_batch.rs`; `llm.md` has its payload and parsing): native and target language, `about`, the library's size (for `level_for`), the mode with its `step` or `topic`, a `count` (30 for a check grid, so a third can be filtered away; 12 for a starter), and `recent`, the last 60 terms of the seed followed by what was shown, so the prompt stays bounded however long the run.

It is **not a task** (`tasks.md`): like the reader's lookup it is one short call whose answer only this screen shows, and what it leads to — the added words — lands through the repositories the moment it is added.

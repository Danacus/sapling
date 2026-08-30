# Reading mode — design

Status: **slice 1 implemented.** The vision is larger than the slice; §7 lists
what is deliberately left out.

## 1. Why

Every challenge type drills words the learner already has. Reading mode is the
other half of comprehension: a whole text in the target language — written by
the model *from* the learner's vocabulary, or pasted in from somewhere else (a
video transcript, an article) — read or listened to, with the app knowing which
words the learner owns, which are new, and what each one means.

It is the LanguageReactor idea on top of Sapling's own knowledge model: a word's
status is not a colour the learner paints on but a fact the app already holds —
in the garden with an FSRS strength, marked as known, or not yet met.

## 2. Shape of the feature

1. **Library** (`/read`). Every text the learner has kept, newest first, and a
   composer with two doors: *Write one for me* (optional topic → one LLM call)
   and *Paste a text* (textarea + title → one LLM call that annotates it).
2. **Reader** (`/read/[id]`). The text as one continuous body of tappable words
   with ruby readings, a whole-text translation toggle, a Listen button, and a
   word card for whatever was tapped.
3. **Marks.** From the word card the learner can *add* a new word to the garden
   (through `add_words`, verbatim) or mark it *known*. Both are events and sync.

A text is immutable once stored. Everything adaptive — which readings show,
which words are highlighted — is derived at render time from the vocabulary and
the marks, so a text written last month shows today's knowledge.

## 3. Data (`src/lib/types.ts`, `src/lib/db/`)

Types are already in `src/lib/types.ts`: `ReadingText`, `ReadingSentence`,
`GlossEntry`.

### What a word can be, and what touching it means

LingQ is the reference point. There a word is *blue* (never seen), *yellow* (a
"LingQ": looked up and saved, reviewed by their SRS, its status 1–4 fading the
highlight) or *known* (✓, or — their load-bearing mechanic — paged past without
a lookup); plus *ignore* for names and numbers. The lookup is what creates a
learning item; not looking something up is an implicit "I know this".

Sapling's garden (`KnowledgeItem` + FSRS) *is* the yellow. What it lacked was
*known*: words the learner understands that should be neither highlighted,
glossed nor drilled. Three acts, kept distinct:

- **Tap a word — "I don't understand this, explain."** A *lookup*. It shows the
  gloss and records a `wordLookedUp` fact. It does **not** add the word to the
  garden (LingQ does; here adding stays an explicit tap, because the garden is
  what gets scheduled and must not fill up by accident) and it is not a
  review — but a lookup on a *tracked* word is FSRS evidence, so the fact is
  kept now for the slice that interprets it (§7).
- **"I know this" — a status declaration**, LingQ's ✓: `wordMarked`. Not a
  review. Known words stop being highlighted or glossed, and they are handed to
  the generator as vocabulary it may use freely, so texts get richer without
  the garden holding every function word. Explicit only in this slice; LingQ's
  implicit version can come later as one deliberate per-text action
  ("Finished — mark the remaining new words known"), which needs no new event.
- **"Add to my words"** — `add_words`, verbatim: the word becomes tracked.

### Events

Four new events, in the house pattern (`events.ts` zod payload, `materialize.ts`
rule, `schema.ts` table, `DERIVED_TABLES`, repositories, tests against the real
in-memory store):

| Event | Payload | Rule |
|---|---|---|
| `textAdded` | `{ id, title, source, topic?, sentences, glossary, createdAt }` | insert-or-ignore into `texts`, unless tombstoned |
| `textDeleted` | `{ textId }` | tombstone in `textTombstones`, delete from `texts` |
| `wordMarked` | `{ term, known: boolean }` | last-write-wins by `at` into `wordMarks(term PK, known, updatedAt)` |
| `wordLookedUp` | `{ term, itemId?, textId }` | insert into `lookups(id PK, term, itemId, textId, at)` — a fact, read by nothing yet |

`texts` stores `sentences` and `glossary` as JSON columns; a learner has a few
dozen texts of at most a few thousand characters, so `getTexts()` returns them
whole. Repositories: `addText(text)`, `getTexts()`, `getText(id)`,
`deleteText(id)`, `markWord(term, known)`, `getKnownTerms()` (terms with
`known = 1`), `recordLookup(term, textId, itemId?)`. Terms are stored trimmed,
verbatim; matching is the reading module's job (§5).

## 4. The two LLM calls (`src/lib/reading/`)

Stateless, like `$lib/conversation`: never imports `$lib/db`. Mock/real dispatch
in `index.ts` on `isMockMode()`; both envelopes pinned with `responseFormat`,
re-parsed with zod, `.nullish()` normalised to absent (`schemas.ts`, mirroring
`$lib/conversation/schemas.ts`, including its `strictJsonSchema` pass).

**Generate** (`generate.ts`). Input: profile (languages, level, interests,
`about` capped like `MAX_ABOUT_CHARS`), the vocabulary as terms (capped), a set
of *focus* words (due items, most overdue first, up to ~12, with meanings), an
optional topic. Output envelope:

```
{ title, sentences: [{ text, reading, translation }], glossary: [{ term, reading, meaning }] }
```

Rules the prompt carries: a coherent short piece (story, dialogue, note,
article) at the learner's level, sentence count by level (beginner 6 …
advanced 12); built mostly from the vocabulary, every focus word used at least
once; a *few* new words are welcome — this is comprehension, not a drill — and
**every word not in the vocabulary list is glossed**. `reading` is the Latin
reading of the sentence, `null` for Latin scripts (the `TargetText` rule).
`translation` is the sentence in the native language. For scripts written
without spaces the glossary must list every word, because it is also how the
app segments the text (§5).

**Annotate** (`annotate.ts`). For a pasted text. Sentences are split
**locally** (`sentences.ts`: sentence-final punctuation `.!?。！？` and hard
newlines; pure, tested) so the text on screen is exactly what was pasted; the
model receives the numbered sentences and returns, index-aligned:

```
{ title, sentences: [{ reading, translation }], glossary: [{ term, reading, meaning }] }
```

A `sentences` array of the wrong length drops the translations/readings
(all-or-nothing, the house rule for aligned lists) and keeps the glossary.
Import is capped at `MAX_IMPORT_CHARS` (4000) for this slice.

Both return `{ title, sentences, glossary, usage }`; the page mints `id`
(`newUuid`) and `createdAt` and calls `addText`.

## 5. Annotation at render time (`src/lib/reading/annotate.ts`, pure, tested)

**Segmentation.** Spaces delimit words in most scripts; Chinese, Japanese and
Thai need a dictionary. The browser has one: `Intl.Segmenter` with
`granularity: 'word'` (ICU, built into every current browser and Node 22, no
download) — `我们|去|银行|取|钱|然后|骑|自行|车|回家`, and Japanese and Thai
too, which the app has no romanizer for. `pinyin-pro`'s own `segment()` was
checked and rejected: it only groups what its polyphone dictionary needs
(我|们, 然|后). jieba ports are more accurate for Mandarin but cost a multi-MB
dictionary, and the term override below fixes the splits that matter.

So `segmentWords(text, locale)` in `$lib/text` (a leaf, dependency-free) wraps
`Intl.Segmenter`, with a per-character fallback where it is missing, and every
tokenizer builds on it: **ICU word boundaries are the base; vocabulary,
glossary and known terms override them by greedy longest-match on top**, so a
word the learner is studying stays one cell even where ICU splits it (自行车).

The tokenizer is the romanizer's when the language has one (`$lib/romanize`,
`tokenize(text, terms)` — whole-sentence pinyin, grouped around `terms`, and
now around ICU words for spans no term claims), else `tokenizeByTerms(text,
terms)` in `tokenize.ts`: word runs with greedy longest-match of multi-word
terms, case-insensitive, for spaced scripts; the segmenter walk with term
override for unspaced ones; whitespace and punctuation runs are their own
tokens; concatenating every token's `text` reproduces the input. `terms` is the
union of vocabulary terms, glossary terms and known terms.

`wordKey(s)` = trimmed, NFC, lower-cased — the one normalisation, used on both
sides of every lookup.

Each token becomes a `ReadingWord`:

```ts
type WordStatus = 'tracked' | 'known' | 'new' | 'plain';
interface ReadingWord {
  text: string;            // verbatim
  reading: string | null;  // after the visibility decision
  key?: string;            // wordKey(text); absent for whitespace/punctuation
  status: WordStatus;
  itemId?: string;         // tracked
  maturity?: Maturity;     // tracked — `maturityOf` from $lib/session/progression
  gloss?: { term: string; meaning: string; reading?: string }; // tracked (from the item) or new (from the glossary)
}
```

Status: punctuation/whitespace-only (`isPunctuationOnly` from `$lib/text`) →
`plain`, no key. Otherwise by key: in the vocabulary → `tracked`; in the known
set → `known`; in the glossary → `new`; else `plain` with a key (tappable, no
gloss — the card lets the learner type a meaning).

Reading visibility, under the learner's `RomanizationMode` (`$lib/ui/prefs`):
`'on'` keeps every reading, `'off'` nulls every reading; `'adaptive'`: `known`
→ null; `tracked` → one roll per key per text open with
`hideReadingProbability(wordStrength(card, now))` from `$lib/session/romanization`
(memoised in a `Map` the caller owns, so a word reads the same in every
sentence); `new`/`plain` keep theirs. A sentence's stored `reading` (the
no-romanizer fallback) shows iff at least one of its words kept a per-word
reading — under `'on'` always, `'off'` never.

## 6. UI (`src/routes/read/`)

Mobile-first, per `layout.md`. The reader is prose, so the text column is
`--measure`; at ≥48rem the page becomes a spread — text on one side, the word
card on the other (the doing and the state). On a phone the word card is a sheet
pinned to the bottom.

Word rendering: each word is a `<button>` carrying its status class; readings
are ruby (`RubyText`'s conventions — `ruby-position: over`, no ruby element for
a null reading). Colours: `new` an accent underline; `tracked` the garden's bed
colours by maturity (`--accent` sprouting, primary/amber mix growing, `--primary`
rooted) as a soft underline; `known` and `plain` bare.

Word card: term (display face), reading, meaning; `SpeakButton`; for `tracked`
the maturity label ("in your garden · growing"); for `new` **Add to my words**
(→ `addWordsTool.run({ words: [{ term, meaning, romanization }] }, defaultToolContext())`
from `$lib/assistant`) and **I know this** (→ `markWord(term, true)`); for
`plain` the same two, with a meaning input in front of *Add*; for `known`
**Unmark** (→ `markWord(term, false)`). Opening a card records
`recordLookup(term, textId, itemId?)`, fire-and-forget. After a write the page
reloads its items/known terms so the text recolours in place.

**The text is one body, not a list.** The model returns sentences because the
annotation is keyed on them, but the learner reads a text: the sentences flow
inline in one paragraph, joined by the script's own rule (a space for Spanish,
nothing for Chinese — `usesInterWordSpaces` on the text itself). The controls
are per *text*: a **Translation** toggle (hidden by default — reading it stays a
choice, as in conversation mode) reveals the sentences' translations joined as
one block, and the stored sentence readings are offered the same way, as a
**Reading** toggle, **only when there is no local romanizer** — beside ruby they
would print every reading twice. Header: title, source, **Listen** (speaks the
sentences in order with `await speak(...)`, `stopSpeaking()` on stop) and
**Delete**. Home gets a "Read something" card beside "Have a conversation",
under the same condition.

### As built, where it differs from the above

- `add_words` is imported from **`$lib/assistant/tools`**, the path
  `$lib/conversation/teacher` already reuses it by; `$lib/assistant`'s barrel
  does not re-export the def.
- A **`tracked` word's card carries no actions** — only its bed label. Adding it
  again is a no-op and marking a scheduled word "known" would mean two answers
  to one question; the garden is where a tracked word is managed, and a reading
  session is not the place to leave for it (an "Open garden" link was tried and
  dropped for exactly that reason).
- **Unmarking names the stored spelling.** `wordMarks` is keyed by the term
  verbatim while a word's *status* is matched by `wordKey`, so `Unmark` looks the
  term up in `getKnownTerms()` rather than sending the spelling this text
  happens to use.
- **The word card's reading ignores the fading rule**: it shows the token's
  reading, or the gloss's, whatever the `RomanizationMode`. Opening a card is the
  learner asking to have the word explained, and the mode governs the prose,
  which is where a crutch is a crutch.
- **Every confirmation lives in the panel** — the same slot as the word card
  (facing page on a desk, sheet at the foot of a phone), never `window.confirm`,
  never extra buttons in the header and never a line above the text. Delete
  (header) and Finished (a primary button at the *end* of the text, where the
  learner is when they have finished it) both open there; the header keeps one
  shape whatever is being decided, and the receipt takes the Finished button's
  place. A **legend row** above the text names the three underlines.
- Home's shared card skin was renamed `.talk-*` → **`.door-*`**: two cards wear
  it now, and only one of them is a conversation.

### Reading as review (slice 2, built)

A reading session grades the garden words in it, through the same
`updateItemAfterReview` the drill uses, so every grade is an ordinary
`itemReviewed` in the ledger:

- **A lookup on a tracked word is `Again`** — recall failed in context, with the
  reading often showing, the easiest conditions there are. Once per word per
  text open (re-tapping a word already lost is not a second failure; needing it
  again tomorrow is). The page keeps the set (`lapsed`), so the card's status
  line says "Counted as forgotten" and the word's underline goes *dotted* in its
  bed colour — a change of texture, not of hue, because the page already
  carries three colours and a fourth would read as an alarm.
- **Not looking up is `Good`, at one explicit moment: the Finished button.**
  It confirms in the panel, and the confirm card says what it will do. Every
  tracked word read without a lookup gets one `Good` (same-day repeats of a word
  reviewed yesterday add almost nothing to stability, so the count needs no
  cap). The `new` words read *without a tap* **can** be marked known too —
  LingQ's paging — but only through a checkbox in the confirm step that is
  **off by default and never remembered**: a word becoming known because the
  learner did not happen to tap it is LingQ's most-resented mechanic, so here
  it is ticked on purpose, every time. A tapped `new` word is never eligible —
  the learner needed it explained. `plain` words are left alone: unglossed,
  they are as likely to be a segmenter's slip as a word. A one-line receipt
  follows ("12 garden words read fine · 1 forgotten · 4 new marked known").
- `known` words, the streak and the daily count are untouched: the count is
  keyed on challenge results, and whether reading should extend a streak is a
  separate decision.

## 7. Not in this slice

- Questions about the text (LLM, chat-style).
- Target-language explanations on tap (immersion glosses); on-demand lookups
  for unglossed words.
- Audio-first (listen before reading) presentation; per-word timing.
- Editing a text, re-annotating, longer imports than `MAX_IMPORT_CHARS`.

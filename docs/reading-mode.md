# Reading mode — design

Status: **slices 1–4 implemented** (the reader, reading as review, subtitle
import, the follow view). The vision is larger than what is built; §7 lists what
is deliberately left out.

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
2. **Reader** (`/read/[id]`). The text a page at a time (`?p=`), each page one
   continuous body of tappable words with ruby readings, a translation toggle, a
   Listen button, and a word card for whatever was tapped.
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

## 4. The three LLM calls (`src/lib/reading/`)

Stateless, like `$lib/conversation`: never imports `$lib/db`. Mock/real dispatch
in `index.ts` on `isMockMode()`; every envelope pinned with `responseFormat`,
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

**The glossary rules are shared verbatim** between this call and Annotate
(`GLOSSARY_RULES` in `generate.ts`, spread into both system prompts): both fill
the same field for the same reader, so they say the same thing by construction.
Two of the rules exist because matching is `wordKey` and nothing else — no
stemmer, no dictionary:

- **`term` is the form the text actually uses, character for character, never a
  base or dictionary form.** A gloss written for the base form of an inflected
  word matches no token, and the word arrives as `plain` with nothing behind it.
  The base form belongs in `meaning` if it helps.
- **A word is "in vocabulary" only when the identical term is listed there.** A
  longer word that merely contains one, or a derived or inflected form of one,
  is a different word and gets its own entry (学 does not cover 学习; "walk"
  does not cover "walked"). Left unsaid, a model reads the containment as
  "already known" and skips the entry.

**Annotate** (`annotate.ts`). For a pasted text. Sentences are split
**locally** (`sentences.ts`: sentence-final punctuation `.!?。！？` and hard
newlines; pure, tested) so the text on screen is exactly what was pasted; the
model receives the numbered sentences and returns, index-aligned:

```
{ title, sentences: [{ reading, translation }], glossary: [{ term, reading, meaning }] }
```

A `sentences` array of the wrong length drops the translations/readings
(all-or-nothing, the house rule for aligned lists) and keeps the glossary.

**Chunking.** `MAX_IMPORT_CHARS` (4000) is the budget for **one call**, not for
the import: past a few thousand characters a model thins out the later
translations and the glossary stops covering the tail, invisibly.
`chunkSentences` (`chunks.ts`, pure, tested) packs the sentences greedily into
chunks of that size and never splits one; `annotateReadingText` in `index.ts`
runs them **sequentially** — a rate limit is the ordinary failure, and a
failure should stop at the first chunk rather than after all of them — through
the unchanged single-call path, and merges: sentences concatenated in order,
glossaries concatenated and deduped by `wordKey` (first wins), `usage` summed,
title from the first chunk. The alignment rule is therefore now
**per chunk**, which is strictly kinder: a model that miscounts one chunk costs
that chunk's annotations, not the whole text's. The learner's title goes only to
the first call, so the text is not named after its middle.
`MAX_IMPORT_TOTAL_CHARS` (40 000) caps one whole import — a cost and patience
ceiling, about ten calls — and is enforced by the page;
`importCallCount(sentences)` is what it shows ("about N calls") before spending
anything. `ReadingOptions.onProgress(done, total)` fires once per chunk.

**Subtitles** (`subtitles.ts`, pure, dependency-free, tested). The learner's
route to a text is usually a video, and the subtitle file is the one artefact of
it they can get: `yt-dlp --write-subs --write-auto-subs --sub-format vtt`, or
the "Show transcript" panel copied. `detectSubtitleFormat` recognises SRT, VTT
and the panel and returns `undefined` for prose, so the composer keeps **one
door**. `parseSubtitles` cleans a file to `Cue { start, end, text }` — BOM,
CRLF, `NOTE`/`STYLE`/`REGION`, cue identifiers and settings, every `<...>` tag
(including the per-word `<00:00:01.240>` timestamps), the named entities — and
de-duplicates YouTube's *rolling* auto-captions, where each cue repeats the line
above it with a ten-millisecond transition cue between every pair: a line is
emitted the first time it is seen and keeps that cue's timing, and a cue left
empty is dropped. `cuesToSentences` then undoes the cueing — cue texts joined
with a space, or with nothing between two CJK characters, `splitSentences` over
the join, and each sentence's offsets recovered with a cursor and `indexOf` and
mapped back to the cues holding its first and last character. The separator is
deliberately not a newline, which `splitSentences` splits on. A transcript with
no sentence-final mark anywhere — the common auto-caption case — degrades to one
sentence per cue rather than one sentence per video. The timings land on
`ReadingSentence.start`/`end` (milliseconds into the media, both or neither),
zipped on by the page so the module never learns where the text came from.
Nothing reads them yet (§7).

Both return `{ title, sentences, glossary, usage }`; the page mints `id`
(`newUuid`) and `createdAt` and calls `addText`.

**Look up** (`lookup-call.ts`). The third call and the only one that runs *while*
reading: one word the glossary missed, for the card the reader opens on a
`plain` word. Input `{ profile, term, sentence, title? }` — the tapped word
exactly as the text spells it, and the whole sentence around it, so a word with
several senses comes back in the one it is actually being used in. Output is one
glossary row, `{ term, reading, meaning }` — `glossEntrySchema` itself, because
that is what it becomes — with the same reading rule as above and a `meaning`
that is this sentence's, in the native language, in one line. All-or-nothing: an
unusable reply throws and the card shows the error, because a gloss without a
meaning is nothing to render. **`term` is taken from the request, not the
reply**: the entry is about to be matched against a token character for
character, and a model that helpfully returned the dictionary form would leave
the word `plain` with no sign anything had happened.

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
`plain` the same two, with a meaning input in front of *Add* and a **Look it
up** button beside them; for `known` **Unmark** (→ `markWord(term, false)`).
Opening a card records `recordLookup(term, textId, itemId?)`, fire-and-forget.
After a write the page reloads its items/known terms so the text recolours in
place.

**Look it up** is the one paid call the reader makes, and it fires only on that
press — a tap is free and stays free. The `GlossEntry` it returns goes into a
page-owned `extraGlossary` (a `$state` array, deduped by `wordKey`) which is
merged into the `AnnotateContext`'s glossary, so the word turns `new` — orange
underline, gloss on its card, *Add to my words* pre-filled with the meaning —
everywhere it appears, for the rest of that open. It is deliberately **not
persisted**: a text is immutable, and if the word mattered the learner adds it,
which puts the meaning on the item where it *is* kept. Nothing extra is
recorded: the tap that opened the card already wrote `wordLookedUp`.

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
  (header) and the page's primary button (at the *end* of the page, where the
  learner is when they have read it) both open there; the header keeps one
  shape whatever is being decided, and the receipt takes that button's
  place. A **legend row** above the text names the three underlines.
- **The text is read a page at a time.** A page is a window of consecutive
  sentences packed greedily to at most `PAGE_WORDS` (30) — `paginate` in
  `src/lib/reading/pages.ts`, pure and tested — and a break falls only between
  sentences, so the last sentence of a page is always finished. Words rather
  than a sentence count, because a generated text is 6–12 short sentences and
  an import is up to `MAX_IMPORT_TOTAL_CHARS` of somebody else's prose; words rather
  than characters, because 700 characters is 120 words of Spanish and 700 of
  Chinese. The count is ICU's base segmentation (`countWords` over
  `segmentWords`), never the annotated tokens: vocabulary overrides the
  segmentation by longest match, so the annotated count can change by one when
  the learner adds a word, and a break that moves mid-read is a bug. The page number is `?p=` (1-based, clamped
  to the last page), read from `$app/state` and written with
  `goto(url, { replaceState: true, noScroll: true })` — replace, because Back
  belongs to the library and a ten-page text should not take ten presses to
  leave. **Nothing about the position is stored**: opening from the library
  lands on page 1, deliberately, since a bookmark would be a fact to sync and a
  page is cheap to skip. `lines` stays the annotation of the *whole* text (the
  roll map is text-wide) and only `pageLines` is rendered; Listen, the
  translation and the stored-reading block all follow the page. The finish row
  carries "Page N of M", the primary button (**Next page**, or **Finished
  reading** on the last), and a quiet **Previous page** link — back writes
  nothing, so it needs no confirmation.
- Home's shared card skin was renamed `.talk-*` → **`.door-*`**: two cards wear
  it now, and only one of them is a conversation.

### Reading as review (slice 2, built)

A reading session grades the garden words in it, through the same
`updateItemAfterReview` the drill uses, so every grade is an ordinary
`itemReviewed` in the ledger. **The unit is the page**, and the guard against
grading the same word twice is not a set the reader keeps but the grade the word
**last got today**, folded out of the item's own `recentGrades`
(`getAllItems({ withRecentGrades: true })`, last entry, `localDay(entry.at) ===
localDay(now)`). Deriving it rather than holding it is what makes reading and
drilling one ledger: it survives a reload, and a word lost in this morning's
drill arrives in the text already counted as forgotten.

- **A lookup on a tracked word is `Again`** — recall failed in context, with the
  reading often showing, the easiest conditions there are. Once per word per
  *day*, not per text open: re-tapping a word already lost this morning is not a
  second failure; needing it again tomorrow is. The card's status line then says
  "Counted as forgotten" and the word's underline goes *dotted* in its bed
  colour — a change of texture, not of hue, because the page already carries
  three colours and a fourth would read as an alarm. Both are keyed on the
  derived grade, so they are still there after a reload.
- **Not looking up is `Good`, at one explicit moment per page:** the primary
  button at the end of it (**Next page**, or **Finished reading** on the last).
  It confirms in the panel, and the confirm card says what it will do. Every
  tracked word *on that page* gets one `Good` unless the learner tapped it **on
  that page**, or it already has a `Good` today. Those are two different guards
  doing two different jobs: the per-page tapped set is what lets a word looked up
  on page one and read fine on page three count as remembered — the `Again` put
  its card into relearning and the later `Good` is what graduates it, which is
  the whole value of a re-encounter — while "not already `Good` today" is what
  stops a word that appears on every page collecting a `Good` per page.
  The `new` words read *without a tap* **can** be marked known too —
  LingQ's paging — but only through a checkbox in the confirm step that is
  **off by default and never remembered**: a word becoming known because the
  learner did not happen to tap it is LingQ's most-resented mechanic, so here
  it is ticked on purpose, every time. Eligibility for *that* is text-open-wide,
  not per page — a `new` word tapped on page one is never marked known on page
  four. `plain` words are left alone: unglossed, they are as likely to be a
  segmenter's slip as a word. The confirm step speaks for the page ("3 garden
  words on this page … will be reviewed as remembered", or "every garden word
  on this page was already reviewed today"); the one-line receipt on the last
  page totals every page confirmed in this open ("12 garden words read fine ·
  1 forgotten · 4 new marked known"), because it appears once, under
  "Finished", and a last page whose words were all graded on page one would
  otherwise read as a failure.
- `known` words, the streak and the daily count are untouched: the count is
  keyed on challenge results, and whether reading should extend a streak is a
  separate decision.

### The follow view (slice 4, built)

A subtitled text that names the recording it came from opens **following the
clock**: the video on top, the line being spoken under it, and the rest of the
text one press away.

It is a **view on the same page, not a route**, and that is the whole design.
Everything under it is unchanged — the same `AnnotateContext`, the same `lines`
over the whole text, the same whole-text `selected`, the same word card. Only
the *page* is cut differently: following, `pageRange` is `{ start: i, end: i+1 }`
for the sentence whose `start` most recently passed the clock, so the
translation, the stored reading and the whole-text word indices follow the spoken
line without one of them knowing a video exists. `?view=text` is the paged
reader, and back. **Listen** is the one header control that goes: synthesising a
line the recording is speaking is a worse version of what the learner already
has, so it is not rendered while following and the slot simply goes empty.

**`src/lib/media/`** is the new area, stateless on the same seam as
`$lib/reading` (`media.md` is the contract). `Player` is five verbs and a clock;
`videoPlayer` is that over a `<video>` element, and YouTube's iframe will be the
second implementation of the same interface — which is why `ReadingMedia` defines
both variants now and a `youtube` text falls back to the paged reader rather than
erroring. Milliseconds everywhere except inside `video.ts`, where the DOM's
seconds are converted once. `follow.ts` is pure and holds the four rules a real
subtitle file forces: a gap stays on the last line that *started* (cues do not
tile a recording, and a highlight blinking off in every silence would flicker
through a conversation), `start` is inclusive, an untimed sentence is skipped and
never landed on, and before the first cue there is no current line. Auto-pause
asks `crossedEnd` whether the boundary fell **between two samples**, so it fires
once per crossing rather than on every tick until the next line starts.

**Nothing but the file's name is stored.** A 700 MB mp4 goes in neither the
events log nor OPFS, so `ReadingMedia` is a reference and the `File` handle can
only come from a picker the learner clicked. `files.ts`'s session cache closes
the one gap that would make that feel broken — the open straight after an import
— and dies with the tab; every later open shows "Choose `<name>`" in the video's
place, with the line controls disabled and "Read as text" still working. A file
whose name has changed is accepted anyway: the learner may have renamed it, and
refusing would be the app being certain about the one thing it did not keep.
Media attaches **at import and never afterwards**, because a text is immutable.

**The clock turns no grades.** Page grading is the learner saying "I have read
this"; a video that keeps playing while they look out of the window says nothing
at all. So the finish row, the `Good`s, the mark-known checkbox and the receipt
are the paged view's alone. A *tap* is unchanged in both, because a tap is real:
`recordLookup` fires, a lookup on a garden word is still `Again` once per day —
and it also pauses the recording, which is what the learner would do themselves
one beat later, having lost a line.

Layout is the usual ladder. The phone is the base case and is untouched by all of
it: video sticky at the top, the current line under it in the same tappable
`.prose` markup, the previous and next sentences faint either side as plain text
— context and a seek, not reading, so their words are deliberately not tappable —
then the line controls (replay, play/pause, next, auto-pause, "Read as text") and
the word card as the sheet it always was.

At ≥48rem the view becomes a **frame**: the spread is `100dvh` less the shell's
`padding-block`, header row `auto` and content row `minmax(0, 1fr)`, and the
window does not scroll at all. The facing page is a **transcript** — every
sentence in a list, the current one highlighted and scrolled into view, each line
a seek — which scrolls *inside itself* and wears the word card's own surface,
because it takes the word card's slot and the card *replaces* it. (Its sticky
heading is painted that same surface: in the page ground it read as a bar laid
over the panel rather than as the panel's top edge.) The transcript is gated on
`matchMedia`, not on CSS, because hiding a thousand buttons still builds a
thousand buttons. Its heading is the scroller's first child, flush at the top
edge and carrying the card's padding itself, because a scroller with top padding
sticks its heading *below* that padding and lines scroll visibly through the
strip above it. In the left column the picture is the only thing that gives: the
caption rows are fixed and the video takes the room left over, sized from its
height so the aspect ratio decides its width.

The caption under the video **matches the video**. Once the picture is sized from
its height no stylesheet can know how wide it came out, so it is measured —
`bind:clientWidth` into a `--film-width` custom property on the column — and the
rows take `min(100%, max(var(--film-width), var(--measure)))`: the video's width
where there is one, `--measure` as a floor so a portrait or a small video does
not squeeze the line into a ribbon, and never wider than the column. The picker
that stands in before a file is chosen is measured the same way, so nothing jumps
when the recording arrives. This is not a hole in the measure rule: a caption is
one sentence at a time, not a paragraph.

At ≥72rem the follow view **drops the 64rem cap** — `.shell-follow` on `<main>`,
a new modifier rather than a scoped `.shell` override — and spends the viewport
on the video column, with the transcript held to `minmax(20rem, 28rem)`. This is
the app's one documented exception to "width never makes content bigger", and it
is about a picture: a recording is genuinely better large, while the transcript
opposite stays bounded and the caption underneath is a caption, not a paragraph.
The line goes up a notch here, where it sits under a large picture rather than on
a page. `layout.md` carries the
exception. No third breakpoint; the paged view keeps `.shell-broad` and its
`3fr 2fr` exactly as they were.

Native `<video controls>` stays on — scrubbing, volume and fullscreen are free —
and our buttons add only what a video does not have: the operations that know
where a line begins. Auto-pause is off by default and never remembered, since it
turns a video into a drill. The keyboard mirrors the controls (Space, ←, →) and
stands down whenever focus is somewhere that wants those keys itself. Position is
not stored: a text opens at 0, for the same reason it opens on page 1.

One thing had to be repaired on the way: `textAdded`'s zod payload named neither
`start`/`end` nor `media`, and zod strips what it is not told about. A local
`commit` does not parse, so the timings worked perfectly on the device that wrote
them and vanished on the device they synced to. Both are named now, `texts` has a
`media` column and `DERIVED_SCHEMA_VERSION` is bumped so the read tables rebuild
from the log.

## 7. Not in this slice

- Questions about the text (LLM, chat-style).
- Target-language explanations on tap (immersion glosses).
- Per-word timing (karaoke); audio-first presentation.
- **YouTube.** `ReadingMedia` has the variant and the reader falls back to the
  paged view for it; what is missing is the iframe-API `Player` beside
  `videoPlayer`, and the composer field that takes a URL and keeps the id.
- Editing a text, re-annotating, imports longer than `MAX_IMPORT_TOTAL_CHARS`.

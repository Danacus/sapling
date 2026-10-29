# Sapling — product spec

What Sapling does and the rules it must keep, written so parts of it can be rebuilt against this document rather than against the code. It describes behaviour the learner sees and guarantees the system makes. It does not describe how the current code does it, except in the appendix that maps each part to where it lives today.

Status: **draft, reverse-engineered from the code on 2026-10-11.** Every section ends with *Open questions*: places where the current behaviour looks accidental, inconsistent or unfinished. They are not decisions. The owner edits this document to say what is kept, changed or dropped; until then the code is the reference for anything this spec leaves out.

## What Sapling is

A language-learning app for one learner, local-first. The learner builds a **garden** of words, practises them through short challenges written by a language model, reads and watches real material, and talks with a role-play teacher. Everything the learner produces lives on their own devices; a relay can copy it between devices but never reads it. The only paid dependency is a language model reached with the learner's own key, and the app stays useful without one.

## Principles

These hold across every part and outrank any section below.

1. **Local-first.** All learner data lives on the device. Every feature except model calls, sync and YouTube works offline. Sync, the model and audio may all fail without interrupting the learner.
2. **One log of facts.** Everything the learner did is an append-only event. Everything shown is derived from the log, identically on every device whatever order events arrive in.
3. **The model writes content, never presentation.** A challenge or text is stored once with everything any screen might need; how much help is shown is decided at play time.
4. **Grading is local and free.** Answering never costs a model call. Paid calls happen only on an explicit press, or in the background to keep practice supplied.
5. **One way in for words.** Words enter the garden only through *add words*, whether from the word check, the reader, the assistant or a conversation. Practice never introduces a word.
6. **Difficulty is learned, in one place.** One skill per word and one difficulty per challenge as shown, learned from the learner's answers, decide what is asked. Grading never looks at difficulty.
7. **Sound and speech never block.** Any audio failure degrades to text. Dictation is an input method that fills the composer and never sends anything unread.
8. **Hosts add capabilities, not behaviour.** Web, desktop and Android run the same app. A host may add native storage, speech, captions or an embedded player, but each is discovered by asking the host, never by branching on platform.
9. **Phone first.** Exactly two wider breakpoints. Width buys columns, never longer lines of prose.

## Glossary

- **Word** (card, item): a term in the target language, its meaning in the native language, an optional reading and optional notes. A card is identified by its spelling *plus* its reading, so homographs (长 *cháng* "long", 长 *zhǎng* "to grow") are two cards. Each word has one spaced-repetition card and one learned skill.
- **Garden / library**: all words for one language pair. A learner can have several, one per target language; everything is per library unless said otherwise.
- **Level**: derived from library size, never asked: under 150 words beginner, under 600 elementary, under 2,000 intermediate, otherwise advanced.
- **Reading**: the Latin-script transcription of a target-language string (pinyin, romaji). Latin-script languages have none.
- **Challenge**: one exercise about one or more words, written once by the model and kept in the **pool** for reuse.
- **Help level**: one way of showing a stored challenge with more or less support (bigger word bank, native hint, reading visible, audio first).
- **Memory**: the spaced-repetition model's chance that the learner still recalls a word now (retrievability).
- **Skill**: one learned number per word — how demanding a challenge about it the learner can handle, given they remember it.
- **Difficulty**: one learned number per challenge as shown at a help level, on the same scale as skill.
- **Strength**: a display-only number per word (stability × memory) behind the garden's *sprouting / growing / rooted* beds. It never decides what is served.
- **Aim**: the success rate practice targets (Easier / Normal / Harder).
- **Verdict**: `correct`, `almost` (accepted near miss) or `wrong`.
- **Text**: an immutable piece of reading material — a list of segments, timed (subtitle cues) or untimed (paragraphs) — with an optional reference to a recording.
- **Paid call**: a request to the learner's model provider with their own key. With no key the app is in **mock mode**, where paid calls answer from fixed offline fixtures through the same parsing path.
- **Host**: what the app runs in — a browser, the desktop app, or the Android app.

## Decisions to make first

The open questions that change the most, gathered from the sections below. The first is a confirmed bug (checked against the code), not a choice.

**Confirmed bugs**
- **The day streak** is anchored to the last active day (a month-old streak still shows) and tolerates two missed days. → *Activity page*

**Scope and product**
- Should practice ever stop by itself — a daily goal, a session length, a token budget? Review-ahead currently runs, and spends, indefinitely. → *The practice stream*
- Should there be a daily limit on new words? A 40-word check run makes 40 words due at once. → *Spaced repetition*
- Is *translate to target* (the only full production exercise) retired for good? → *Challenge types*
- Should keyless learners write mock lessons at all? Today they get fixed Spanish or Mandarin sentences tagged with their own word. → *Mock mode*
- Should an overturned answer be added to the challenge's accepted answers, and be recorded as right in history? → *Answering and feedback*
- Readings in the reader are Mandarin-only. Should other non-Latin languages get readings (a local romanizer, or the model's)? → *Romanization*
- Inflected forms never match a tracked word (no lemmatisation), and a homograph can be graded on the wrong card. Accept or address? → *The reader*
- Should conversation and the follow view credit reviews for words used or read correctly? → *Conversation mode*, *Follow view*
- Is `/tts-test` a feature or a developer tool? → *Voice test bench*

**Data, privacy and durability**
- Should sync payloads be end-to-end encrypted with a key from the phrase? The relay currently stores readable JSON. → *Sync*
- Should Reset also wipe the relay room, and should rooms expire? → *Export, import and reset*
- Should the web app request persistent storage so the browser cannot evict the database? → *Storage and durability*
- Import says it "replaces everything" but merges. Which is meant? → *Export, import and reset*
- The model name is stored both in the profile and on the device. Which one is real? → *Learner data*
- Should the first language and added languages keep their different event shapes? → *Languages*
- Should two devices continuing one conversation be safe? Today one exchange is silently lost. → *Conversation mode*

**Hosts**
- Desktop and Android are marked *spike*. What makes them shipped: CSP, signing, a cancellable voice download, reloads that work on deep routes? → *Desktop host*, *Android host*
- Should the first use of a neural voice ever start a 365–439 MB download silently? → *Background tasks*

**Copy that disagrees with behaviour** — cheap to fix, listed in each section: Home's "reviews" counts answers; the Words page empty state points at practice; Profile says languages switch "from home"; the reader's legend uses different bed names; Explore says "bring subtitles"; "Continue reading" always opens at page 1.

---

## Part 1 — The learning loop

How a learner gets words, how they are practised, how hard each challenge is, when each word comes back, and the pages that show progress. Vocabulary entry through the assistant, conversation and reading is in Part 2; here it matters only that every word arrives through *add words* as an ordinary card.

### Onboarding

Purpose: a first-time learner leaves with a language pair, optionally a model key, and — when a model is available — words to practise.

Behaviour
- Any route visited without a profile redirects to onboarding.
- Steps, shown as progress dots:
  1. **Languages**: "I speak" and "I want to learn", each a searchable language picker (fuzzy over English name, own name and code; a flag for a regional variant). Continue requires both picked and different.
  2. **Connect a model**: OpenRouter API key (stored only in this browser), or **Connect OpenRouter** to get one by signing in (as in Settings), and a model name (free text with suggestions, a default pre-filled). Without a key, a note explains that words, lessons and conversations cannot be generated but importing and reading still work.
  3. **How much {target} do you know?** — present only when a key was typed on step 2 (or, when adding a language, a key is already stored) or the developer mock flag is set. Two choices:
     - *Starting from scratch* → saves the profile and opens the word check in **starter** mode.
     - *I know some already* → saves the profile and opens the word check in **check** mode.
- Without step 3, the last step's button ("Start learning", plus a "Skip for now" link on the model step) saves the profile and lands on Home.
- **Adding a language** (entered from the app menu) shows only the languages step and, when a key is stored, the level step; it creates a new library and never touches the key.
- **Pairing**: on the first step only (and only when sync is available), a second card lets the learner join an existing library from another device by pairing phrase. Pairing never writes a profile; on success it goes to Home, otherwise it explains and keeps the phrase for retry.

Rules
- No level is asked or stored; the learner's level is derived from library size wherever a prompt needs it (see Lesson writing).
- The profile written here holds the two languages — each a BCP-47 tag plus its CLDR English name, which prompts and older builds read — the model, and a creation time. Deprecated `level`/`interests` fields are written with fixed values only so older builds can parse the profile.

Open questions
- With no key, the model step shows both a "Start learning" button and a "Skip for now" link that do exactly the same thing.

---

### Check what you know (word check)

Purpose: build a starting vocabulary fast by tapping words the learner already recognises, or by taking a topic's starter set.

Behaviour
- Entry points: onboarding's level step, Home's empty-library hero (when a model can write), and Explore.
- **Check mode**: an intro, then grids of up to 20 tiles. A tile shows the term (and reading); tapping selects it and reveals its meaning, so a wrong guess can be untapped. **Next** adds the selected words and fetches another grid; **Done** adds them and shows a summary ("N words added", *Practice now*, *Back to Explore*).
- **Starter mode**: pick a topic (preset chips — Greetings, Food, Travel, Family, Work — or free text), then one grid of 12 words on it, all pre-selected. **Add these** adds and finishes; **More on this topic** adds and fetches another 12.
- A running "N added" counter shows words actually added (duplicates of existing cards are not counted).

Rules
- Words are added at every step forward, never batched to the end; leaving at any moment keeps everything already moved past. A sent word is locked on its tile.
- **Step rule** after each check grid: ≥70% tapped → next grid harder; <30% → easier; otherwise same. An empty grid stays "same".
- First grid: empty library → "start" (the most common everyday words); non-empty library → "same as the most recently added words".
- The model is told to exclude every term in the library and every term shown this run (newest 2,000 kept). This is a hint only: the client drops anything that is the same card as a library word, a word already shown, or a repeat within the grid, and fetches again — up to 3 calls — until the grid is full. After three it shows what it has; a grid with nothing new is a retryable error.
- A grid fetch is a short foreground call, not a background task. A failure leaves the grid in place and pressing again only re-fetches; if a later call in a multi-call grid fails, the learner gets the words already gathered.
- No frequency rank, no vocabulary-size estimate, no stored state of its own. Tapped words go through the same add-words path as everywhere else and become fresh cards, due immediately.

Open questions
- Words tapped as "already known" and words from a starter topic (genuinely new) start with identical cards and identical starting skill; nothing records that the learner claimed to know them.
- A large check run makes dozens of words due at once (see SRS open questions on new-word limits).

---

### Home ("Today")

Purpose: one recommended next action, plus a glance at the collection and recent activity.

Behaviour
- Header: "Learning {target}", title "Today", and a day-streak badge.
- **Hero** — exactly one recommendation, first match wins:
  1. No words and no model → "Add a model key to generate your first words" → Settings key field; secondary "or import a text" → Media's Text drawer.
  2. No words → "Plant your first {target} words" → word check.
  3. Words due → "N words ready" → Practice (copy mentions reviews already done today, if any).
  4. Otherwise → "Your garden is caught up" → Explore.
- **Continue**: the three most recent conversations and reading texts, newest first, linking back into them.
- **Garden**: total word count and a bar split into *sprouting / growing / rooted* (strength below 0.15, below 0.45, and above). Links to the Words page.
- **Activity**: last seven local days as bars of answers per day, plus "N reviewed today" / "A quiet day so far". Links to the Activity page.

Rules
- Due count = words whose card is due now.
- Home's "reviews today" is the number of challenge answers logged today (match rounds included), not distinct words reviewed.
- Numbers are a snapshot taken when the page loads.

Open questions
- The label says "reviews" but counts answers; the Activity page separates "answers" from "words reviewed". Pick one meaning.
- "Caught up" points to Explore although practice can always continue into review-ahead; is that intended?

---

### Practice start screen

Purpose: show what practice would do right now and start it; optionally write challenges ahead of time or on a topic.

Behaviour
- **Practice card**: title "N words ready" / "Practice is ready" / "Prepare to practise".
  - Figure **covered / upcoming** labelled "Due words with fresh challenges" when anything is due (upcoming = every due word), otherwise "Next words with fresh challenges" (upcoming = the next 20 soonest-due words). *Covered* = the word has a challenge available right now (same rule serving uses).
  - Figure **words due**.
  - **Start practising**, enabled when the stream would serve something immediately, or any word further down has something, or (with a key and a connection) a batch could be written for the first word.
  - A notice line: no words → "a lesson practises words you already have" with links to Conversation and Assistant (no generate button); nothing startable → says so (and that offline blocks writing); nothing due but startable → "practice reviews words before they're due".
- **Lesson card** ("Write ahead or on a topic" with a key; "Write a new lesson" in mock mode): optional topic (free text, 8 fixed chips with 4 shown, recent topics remembered on this device), and a button:
  - "Write N new challenges" (N = what a press would write), "Everything is covered" when N = 0 (disabled), "Add words before writing a lesson" with no words, "Generating…" while running.
  - One line of outcome: the task summary ("N challenges added — M requests failed") or the error with *Try again*.
- In mock mode, when the first word has nothing or at most half of the figure's words are covered, the lesson card is highlighted and the notice nudges toward it.

Rules
- Starting never touches the network and is instant; the stream decides everything once started.
- A press writes for the **whole collection** in urgency order (not just the next few words), only for words with nothing available, two challenges per such word, capped at 24 per press; the next press continues where the cap cut off.
- A topic colours the lesson; it adds no extra challenges and does not change which words are written for.
- With a key and a connection the card is framed as optional: the stream writes what it needs by itself.
- The generation runs as a background task that survives navigation; the screen re-reads its figures when one finishes.

Open questions
- The topic is stored on each written challenge but nothing reads it back (no topic filter, no topic-biased serving).
- Recent topics are per-device, unlike everything else about the learner.

---

### The practice stream

Purpose: one continuous run of challenges, always about the word the schedule most needs, at a difficulty that lands near the learner's aim, until the learner stops.

Behaviour
- Top bar: a stop ✕ and an "N answered" counter (no progress bar; there is no planned length).
- Each challenge is picked only after the previous answer's writes have landed, against the store as it is then (so the last review, skill change and serve stamp are visible to the next pick).
- **Which word**: the list of words in urgency order — due words first, most overdue first; then not-yet-due words, soonest due first (review-ahead); ties by id. Words without a term or meaning are skipped.
- **Which challenge for that word**: among the word's *available* challenges (below), prefer rested over resting, then the help level whose predicted success sits closest to the aim, then never-served (newest first) over served (longest ago first).
- **Waiting**: when the head word has nothing available and a batch can be written for it (key + connection, not already asked for), the screen shows "Writing more challenges for you…" with a Stop button, and continues the moment the batch lands. A batch started from the Practice start screen also wakes a waiting stream.
- **Passing**: when no batch can help the head (already asked for, a batch failed or was cancelled, no key, offline), the head is passed for the first word further down the same list that has something. The head stays first and is served the moment it has something.
- **Ending by itself**: only when no word in the list has anything and nothing can be written. The summary then says why — the failed batch's error, no key ("add your key… practice writes more as you go"), offline, or "nothing that fits could be written just now" — with **Try again** beside **Back to Practice**. Try again forgets which words were already asked for.
- **Stopping**: the ✕ goes straight to the summary with no confirmation (straight back to Practice if nothing was answered). Every answer is already saved.
- **Background refill**: after the first pick and after every answer, if the learner can write and no generation is running, the stream asks for challenges for the words among the next *low-water-mark* words that have nothing. The mark is (batch time ÷ answering pace) + 2, clamped to 4–20 words; pace is the median of the last 10 answer times (default 15 s), batch time is the last measured batch (default 45 s).
- **Free match rounds**: after every 4 answered challenges about *early* words (strength below 0.3), the next step is a locally built match-pairs round from early words — 5 pairs, at least 3, unique labels on both sides — but only if a real challenge exists to follow it.
- Audio for each challenge is pre-rendered while it is shown, one clip at a time; the task tray is hidden while a challenge is on screen.
- In mock mode a banner reads "Practice mode — add your OpenRouter key in Settings for personalized content."

Rules (invariants)
- **One list, one predicate.** Serving and refill read the same urgency-ordered list through the same availability rule, so a word refill considers covered is exactly one serving would serve, and a word serving waits on is exactly one refill writes for.
- **Available** = not reported; every word it cites still exists; of a kind still in use; not already shown in this stream; *rested* (never served, or last answered ≥ 3 days ago) — or merely resting when the word is due; and it **fits** (see Difficulty).
- No challenge is shown twice in one stream (this also keeps a word re-queued minutes after a miss from getting the same sentence back).
- A word a refill asked for is never asked for again until something of it is served; a batch that fails or is cancelled gives its words back.
- At most one generation runs at a time; there is at most one refill claim in flight.
- Due-first is load-bearing: freshly written challenges never outrank due reviews.
- An unanswered challenge was never stamped, so it simply returns in the next stream.
- Practice never introduces a word. New vocabulary arrives only through add-words (check, assistant, conversation, reading).

Session summary
- "Practice done" with *correct + almost / answered*, accuracy % (same ratio), **words strengthened** (distinct words practised that were not new), **day streak**, and a **New words** list (words drilled for the first time in this stream, with reading unless readings are Off). Confetti; a two-leaf mark at ≥ 80% accuracy, one leaf below.
- Match rounds count as answers in the counter and summary (correct, or almost if any mismatch).
- On reaching the summary the device triggers a sync push.

Open questions
- The stream never ends on its own while anything is writable: review-ahead continues indefinitely and, with a key, keeps spending tokens on words far from due. Should review-ahead be bounded (a daily goal, a session length, "caught up" stop)?
- A fresh learner's first stream with a key typically opens on a wait (~45 s) because nothing has been written yet; onboarding does not pre-write.
- The summary shows the same ratio twice (score and accuracy), and both include free match rounds, which can never be wrong.
- An overturned answer counts as correct in the summary but stays `wrong` in the result history and the Activity page.

---

### Answering and feedback

Purpose: grade instantly and locally, show the right answer, and let the learner dispute a grade.

Behaviour
- Every reviewing challenge has a **Skip** button until answered. Skip is a `wrong` answer in every respect (FSRS Again, skill falls); the banner says "Skipped — the answer was:".
- On commit a **feedback banner** slides up:
  - Headline: "Correct!", "Almost — we counted it.", "Not quite.", "N of M blanks correct." (a multi-blank answer with some right), or "Accepted — your answer counts." after an overturn.
  - Detail: "Correct form: …" (almost, showing the closest accepted form), "Answer: …" (wrong), "Also fine: …" (overturned); the answer's reading underneath unless readings are Off.
  - The canonical target-language answer **auto-plays once**; "Hear it" replays.
  - The challenge's model-written explanation, if it has one.
  - **Explain** — one press asks the model whether the answer should count and why; a follow-up box allows further questions ("Think you were right? Say why…" after a wrong answer). One press = one model call.
  - **Report** — flags the challenge as broken; it is excluded forever. The stream does not advance (the learner may still want it explained). Not offered on match rounds.
  - **Continue** (Enter anywhere outside a text field).
- **Overturn**: if the explain call agrees a `wrong` answer should have counted, the banner repaints green and the answer counts as `correct` (or `almost` where a blank was almost).

Rules
- Verdict → FSRS grade: wrong → Again, almost → Hard, correct → Good. Never Easy; response time never infers a grade.
- A multi-blank answer reviews each word with its own blank's verdict; the overall verdict is the worst blank.
- An overturn *replaces* the answer's review (the card is refolded as if that grade had been given at the answer's instant); it never stacks a second review.
- An overturn replaces each wrong word's Again with Good, and the difficulty model learns the answer as a success. The stored result keeps what was answered.
- The dispute is judged against what the learner's screen actually showed (visible bank/tiles, whether the native line was shown); without the native line, any correct answer to what was visible counts.
- Match rounds never touch any card or skill; they are logged only.
- Response time is recorded but never graded on (it only sets the refill pace).

Open questions
- An overturn does not add the learner's answer to the challenge's accepted answers, so the same answer is graded wrong again next time the row is served.
- `almost` is auto-Hard with no way for the learner to say "that was fine".
- Explain is offered on match rounds (a locally built drill) and in mock mode (where it never overturns).
- The banner component has a "Finish" label path for a last challenge that the stream never uses.

---

### Challenge types

Purpose: a small set of exercise shapes, each written by the model about specific words, graded locally.

Each type is generated as one of nine **kinds**; kinds map onto six stored shapes plus the free match round. Each written kind has a length range (words, or tiles for word order) the writer chooses within.

| Kind | Learner sees / does | Length range | Help levels (steps) | Grading |
|---|---|---|---|---|
| **Recognize (MC)** | Target-language text; pick its native meaning from 4. Can be served **audio-first** ("Listen — what does this mean?"): the prompt is spoken, its text hidden behind "Show text". | 1–11 | plain; listening | Exact (option chosen) |
| **Produce (MC)** | Native prompt; pick the target-language term from 4. | 1–11 | plain | Exact |
| **Context (MC)** | A target-language sentence/dialogue line; pick the target word that fits from 4 ("Pick the word that fits"). | 3–11 | plain | Exact |
| **Translate to native** | Target text; type it in the native language. | 2–11 | plain | Fuzzy (typed) |
| **Spot the error** | A target sentence as tappable word tiles with one wrong word planted; the native meaning shown; tap the wrong word. Silent before answering. | 3–11 | plain | Exact (tile tapped) |
| **Word order** | Shuffled tiles; build the sentence. Tray shows one slot per answer tile; Check enables when full. | 3–8 tiles | *tiles* (own tiles + native line) · *extra-2* (two distractor tiles, no native line) | Exact token sequence (punctuation-only tiles ignored) |
| **Cloze** | A target sentence with one blank. With a bank: tap a chip into the gap. Typed: an inline input in the sentence. | 3–11 | *pick-4* (4 chips + native hint) · *pick-6* (6 chips, no hint) · *typed* | Exact for a tapped chip; fuzzy when typed |
| **Multi-cloze** | A 2–4 sentence passage with 2–4 numbered blanks and one shared bank; place each chip once, choosing which blank it belongs in. No native hint ever. | 8–18 | *answers* (bank = just the answers) · *extra-2* (two more) | Exact per blank (chips are tapped); worst blank overall |
| **Translate to target** | Native prompt; type it in the target language. | — (retired: neither written nor served) | plain | Fuzzy |
| **Match pairs** (free round) | Two columns, terms and meanings; tap one of each. Right pairs lock with a pop, wrong pairs shake. Selecting a term speaks it. Ends when all matched. | — | plain | correct if no mistakes, else almost; never reviews |

Rules
- **The model emits content, never presentation.** Every row is written with everything any help level might need: the full bank (answer + 5 distractors for cloze), extra tiles (3 for word order), native hint/prompt/meaning, and readings for every target string in languages with a non-Latin script. The help level decides at serve time what is shown.
- Options, tiles and banks are shuffled once when written; at serve time the visible subset is the answer(s) in their stored positions plus the first distractors in stored order — never reshuffled.
- A challenge is structurally checked when written (four options with a valid index, ≥ 2 tiles, ≥ 3 tokens, 2–4 gaps each with its own word, every gap marker once, bank ≥ gaps + 2…); a row failing the check is dropped.
- Stored challenges are read leniently forever: the stored shape only ever gains optional fields; a row this build cannot read keeps its place and is never served.
- A challenge cites the word(s) it is about; one citing an unknown word is dropped at write time. A multi-cloze cites one word per blank.
- Keyboard: digits select options/tiles (1–4 for MC, 1–9 for spot-error), Enter checks; nothing submits on selection alone.

Open questions
- **Translate to target** (the only full production-in-target exercise) is retired: existing rows are never served and none are written. Intended permanently?
- Two grading paths exist: components grade (MC by index, word order by token sequence) while the core has its own per-type `check` (MC by fuzzy option text). They should be one rule.
- Mock fixtures contain fixed sentences (Spanish or Mandarin only) that are merely *tagged* with the learner's word; see Mock mode.

---

### Help levels

Purpose: one stored challenge can serve a weak word with lots of support and, weeks later, the same word with little.

Behaviour
- A help level is a **step** (the per-type list above, easiest first) plus two modifiers:
  - **Reading hidden** — for rows that store readings. Governed by the device's readings setting: *On* (default) never hides; *Off* always hides (every level is a hidden one); *Adaptive* offers every step with reading shown plus the hardest step with it hidden.
  - **Listening** — recognize-MC only, when the device's listening preference is on (default on) and the device can speak the language. If audio plainly did not play (fails or ends in under 250 ms) the text reveals itself; "Show text" is always available.
- A row offers only the steps its stored content can tell apart (a cloze without a bank is only ever typed).
- The level picked is the one inside the fitting window closest to the aim; it is recorded on the answer as `shown`, which is what the difficulty model learns from and what a dispute is judged against.

Rules
- Help-level identifiers are stable strings (`pick-6`, `typed-hidden`, `listening`); an unknown identifier is treated as unknown, never an error.
- Sound never blocks play: any audio failure degrades to the text version of the same challenge.

Open questions
- Readings default to *On*, so under defaults "reading hidden" levels never exist and the hardest levels for non-Latin languages are unreachable unless the learner discovers Adaptive.

---

### Difficulty model

Purpose: put difficulty in one place, on one scale, learned from the learner's own answers, so each challenge lands near the aim.

Concept
- **Prediction**: chance of a correct answer = *memory* × sigmoid(*skill* − *difficulty*).
  - Memory comes from the spaced-repetition card (a never-reviewed word reads 0.9).
  - A challenge about several words multiplies their memories and averages their skills.
- **Difficulty** of a row at a help level = shared base for (kind, help level) + shared slope for the kind × the row's length + the row's own correction.
  - The shared parts get many answers and settle quickly; the per-row correction catches the odd row that is harder or easier than its shape suggests.
  - A row's length is the length it was **asked** to be written at (measured from its shape only for rows without that record), so drift in what the model wrote is absorbed by the correction.
- **Learning**: outcome is 1 / 0.5 / 0 for correct / almost / wrong; surprise = outcome − predicted chance. Each word's skill moves up by its rate × surprise; every difficulty part moves down by its rate × surprise. A miss the model expected (low memory, hard row) moves little; a miss on something "easy" moves a lot; a miss explained by forgetting mostly leaves skill alone.
- **Starting values**: a new word's skill is set so the easiest one-word recognition challenge lands at 90%; bases and slopes have written starting values; corrections start at 0.
- **Aim** (profile): Easier / Normal / Harder = 0.97 / 0.89 / 0.78 chance *given the word is remembered* — about 88 / 80 / 70% actually right at typical 0.9 memory (shown to the learner as "about 9 / 8 / 7 in 10 right"). Changing it takes effect on the next pick; nothing is rebuilt.

The one check (`fits`)
- **Memory picks which word; skill vs difficulty picks which challenge.** An overdue word is judged exactly as it would be on time.
- A row **fits** a word when sigmoid(skill − difficulty) at one of its help levels lies in the **window** around the aim: aim −17 to +4 points.
- The window is **widened per word just far enough to include the nearest challenge that could be written** (any kind in use, any help level a fresh row would be served at under current settings, any length in range). So "too hard" never excludes the easiest possible challenge and "too easy" never excludes the hardest — every word always has something writable that serving will accept, which is why serving can safely wait for a batch.
- A multi-word row fits or not regardless of which of its words it is served for (judged by their average skill).

Writing to the check
- A request to write is {word, kind, length}. The kinds offered are those with some length whose fresh row would fit the word; a kind the word has never had wins, ties are random; a word never gets the same kind twice in one request batch.
- The length is the check solved backwards: the length that puts the word at the aim at the kind's **middle** help level, among lengths that fit — so the row still fits if the word weakens (easier level) or strengthens (harder level).
- A written passage about several words is kept only if it fits them together; otherwise it is dropped and its request stays unfilled.

Rules
- Skills, corrections and shared parts are derived data, recomputed from the answer history in answer-time order (so every device derives identical numbers whatever order events arrive in). Changing the model or a starting value means a full recompute, never a reinterpretation of stored rows.
- Grading never consults difficulty; difficulty shapes which question is asked, never what an answer is worth.
- There is no accuracy dial and no recent-mistakes list: every answer moves skill and correction, which is what the next pick and the next length read.
- Strength (the bar) never steers difficulty; its only effect on practice is pacing the match rounds.
- Tuning is measured by a calibration command replaying a profile export (log loss vs. a baseline, a predicted-vs-actual band table, a rate grid search, simulated learners).

Open questions
- Words tapped as known in the word check and words that are genuinely new get the same starting skill.
- The window is asymmetric and widened; the realised success rate can sit well away from the aim (e.g. review-ahead words with memory near 1, or words outside every writable row). Is the stated "about 8 in 10" a promise or a target?
- A row that fits no word at any level is never served and never deleted; the pool grows without bound.

---

### Spaced repetition (review scheduling)

Purpose: decide *when* each word comes back.

Behaviour
- FSRS-6 with default parameters, desired retention 0.9, maximum interval 100 years.
- Card states: **New → Learning → Review**, and **Relearning** after a lapse.
  - Learning steps: 1 min, 10 min. Again → back to 1 min; Hard → ~6 min (midway); Good → next step, then graduate to the model's interval; Easy → graduate immediately.
  - Relearning step: 10 min after Again on a Review card (counts a lapse).
  - Review intervals are whole days with Hard < Good < Easy enforced (each at least a day apart).
- A word is **due** when its due time is at or before now. A newly added word is due immediately.
- Every answer to a reviewing challenge files one review per cited word at the answer's instant; the card is derived by folding that word's whole review log.
- Shown numbers per word: **due**, **recall chance** (retrievability, by whole elapsed days), and **strength** = log-scaled stability (30 days = mature) × recall chance.

Rules
- One scheduler implementation; screens only read derived numbers.
- Reviews can be *replaced* (overturn) — the card refolds from the log, never compensates.
- **Strength is display only**: the strength bar, the garden's sprouting/growing/rooted beds, the reader's colours, and the match-round "early word" threshold. It never decides what is served or how hard.
- Early review (review-ahead) is graded like any review; FSRS simply banks a smaller gain.
- Numbers are snapshots as of the last read; a page left open across a due time needs a refetch.

Open questions
- **No daily limit on new words**: every added word is due on arrival, so a 40-word check run puts 40 new words at the front of the queue alongside reviews (older additions first, since due = introduction time).
- FSRS parameters are never personalised from the learner's history, although the difficulty model is.
- Day boundaries for intervals are UTC calendar days, while streaks and activity use local days.

---

### Lesson writing (LLM generation as the learner experiences it)

Purpose: turn "these words need challenges" into stored challenges, using the learner's own OpenRouter key.

Behaviour
- Triggered two ways, both as a background task titled "New lesson" (or "New lesson · {topic}") in the task tray with steps (checking what's missing, building prompts, requesting, validating, saving), cancellable, surviving navigation:
  1. **The stream's refill**, automatically, for the next few words that have nothing.
  2. **The learner's press** on the Practice screen, for the whole collection, with an optional topic.
- What is sent: native and target language, the derived level, the optional topic, the learner's "About me" (≤ 500 chars), the **whole vocabulary as terms** (so sentences can be built from words the learner already knows), and per request a list of {word, meaning, length}. Each kind is one request of up to 6 words (configurable), 3 in flight.
- **Level** is derived from library size: < 150 words beginner, < 600 elementary, < 2000 intermediate, else advanced.
- Result: "N challenges added", plus "— M requests failed" when some requests returned nothing usable even after one corrective retry. Failed words simply still want challenges.
- Device settings: model, key, request size and reasoning effort apply to every generation; token usage is metered in Settings.

Rules
- **A lesson introduces no words.** It writes challenges about existing words only; a challenge citing anything unknown is dropped.
- Generation writes only what the list is missing; a press with everything covered fails before spending ("Every word you have already has fresh challenges waiting…"); a press with no words fails ("There are no words to write challenges about yet.").
- Auth, rate-limit and network errors end the whole batch; other failures drop one request.
- Grading is free and local; the only other mid-practice spend is the learner-initiated Explain.
- Prompt changes affect only newly written rows; existing rows play as written.

Open questions
- With a key, cost is unbounded and invisible during practice (see stream open questions); there is no budget or per-day cap.
- The stored profile "About me" changes only new lessons (the profile page says so), but there is no way to refresh stale rows.

---

### Mock mode ("practice mode")

Purpose: make the app usable and developable without a key or spending tokens.

Behaviour
- Active when no key is stored, or when a developer flag is set on the device (no UI toggle).
- Model calls answer from fixtures through the same parsing and validation as real replies: lessons, explanations (never overturn), word-check grids (a fixed easiest-first list per script).
- The practice stream never refills on its own in mock mode; the Practice screen's lesson button writes a mock batch instantly ("In practice mode it's instant and free").
- Home and onboarding treat "no key" as "no model" (no word check offered) — but the developer flag counts as a model.

Open questions
- **Mock lesson content is fixed Spanish or Mandarin sentences merely tagged with the learner's word**, so a keyless learner of French who presses the button gets Spanish sentences that do not contain their word, stored in the pool and graded into their real cards. Should keyless users be able to write mock lessons at all?
- Keyless users can never get words via the word check (Home sends them to Settings), yet the Practice screen advertises free mock lessons once words exist.

---

### Words page ("Garden")

Purpose: full transparency into every word and its schedule — *why* this word is due and that one not.

Behaviour
- Summary tiles that double as filters: Words, Due now, New, Learning, Review, Relearning.
- Search over term, meaning and reading; sort by due date (default, ascending — the stream's order), strength, recall chance, stability, difficulty (FSRS), reviews, lapses, accuracy, first seen, alphabetical; direction toggle.
- Each row: term with reading (always shown here, whatever the readings setting), a readout of the active sort (strength bar for strength/alphabetical; coloured red < 0.5, amber < 0.85, green above), and a speak button.
- Opening a row shows state, due ("in 3 d" / "2 h overdue"), stability, FSRS difficulty, recall chance, interval, reviews, lapses, accuracy (share of reviews graded Good or better), first seen, last review, strength bar, notes, and the last 40 review grades as coloured ticks. Several rows may be open, at most one per visual grid row.
- **Forget** a word: at the bottom of an opened row behind an explicit confirm ("removes its progress and review history. There is no undo."). 
- A "How to read this page" glossary.

Rules
- Forgetting deletes the word's card and history everywhere; every challenge citing it (including multi-word passages shared with other words) becomes unplayable.
- The only write on this page is forgetting.

Open questions
- Empty state says "Your first session writes the first entry" and links to Practice, but practice never adds words. It should point to the word check / assistant.
- No way to edit a word (term, meaning, reading, notes) here; only the assistant can.
- The difficulty model's per-word skill is not shown anywhere, although it decides what the learner is asked.
- Strength colour thresholds (0.5 / 0.85) differ from Home's garden beds (0.15 / 0.45).

---

### Profile

Purpose: facts about the person that shape lessons, and how hard practice aims.

Behaviour
- **About you**: one free-text "About me" (≤ 500 characters, live counter), saved only on "Save profile"; "Applies to new lessons only." A cleared field is removed entirely.
- **Practice**: Easier / Normal / Harder ("About 9 / 8 / 7 in 10 right"); saves immediately on tap, takes effect on the next pick. Absent reads as Normal.
- **Languages**: a language picker each for "Learning" and "From", saved on pick (two different languages, else refused and put back). Meant for a variant or a fix; another language is added from home. A profile whose name resolves to no language says so above the picker.

Rules
- No level and no interests are edited or read; deprecated stored values are preserved on save for older builds.
- Device configuration (key, model, voice, readings, listening, backups) lives in Settings, not here.

Open questions
- The page says "Add or switch languages from home", but that control lives in the app menu.
- Readings and listening — both of which change which help levels exist and therefore difficulty — are per-device settings, while the aim is per-profile and synced.

---

### Activity page

Purpose: look back at the days the learner showed up.

Behaviour
- **Streak card**: current day streak, longest streak, active days, total answers.
- **Calendar**: one Monday-first month at a time; back/forward (not past the current month), "Today" to return. Cell shade (5 levels) is relative to the busiest day in the visible month; a cell's number is its activity total. Future days are disabled.
- **Day detail**: answers with % right (correct + almost), a correct/almost/wrong bar, and counts of words reviewed, looked up and added.
- **Month summary**: active days, answers with % right, words reviewed, words explored (lookups), words planted (added).

Rules
- A day is any local day with an answer, a review, a lookup or a word added.
- Activity total per day = answers + distinct words reviewed + lookups + words added.
- "Words reviewed" per day counts distinct words still in the library.
- **Streak** = consecutive active days counted back from the most recent active day, tolerating gaps of up to two inactive days. Longest streak uses the same tolerance.

Open questions
- The streak is anchored to the last active day, not today: a learner inactive for a month still sees their old streak. And a gap of two missed days does not break it. Both look accidental for a "day streak".
- Looking up a word or adding one counts as a streak day, the same as practising.
- Month "words reviewed" sums per-day distinct counts, so one word reviewed on five days counts five.
- Answers include match rounds (never wrong) and overturned answers stay `wrong`, so "% right" differs from what session summaries showed.

---

## Part 2 — Reading, media and conversation

Everything reached from **Explore**: the Media section (texts to read, listen to or watch), the assistant chat and conversation role-play, plus readings, speech and dictation as they apply there. *Check what you know* is in Part 1.

### Explore

**Purpose:** the hub for meeting new language in context, as opposed to drilling words the learner already has.

Behaviour:
- Explore is a primary destination in the app's main navigation. It shows four doors, each with a title and one line of copy:
  1. **Check what you know** (its intro links to the starter mode, "New to the language?").
  2. **Have a conversation** (goes to conversation mode).
  3. **Read or watch** (goes to Media).
  4. **Ask the assistant** (goes to the chat).
- Home links into these features from three places:
  - The recommendation card. With an empty garden and no API key, it points to Settings and offers "or import a text". With an empty garden and a key, it offers "Check what you know". When nothing is due, it offers "Explore something new".
  - A "continue" list of the three most recent conversations and texts.
  - An "All activities" link.
- The reader (`/read/<id>`) and an open conversation (`/converse/<id>`) are
  *immersive* screens: the main app navigation is hidden there, and each screen has its own back link to its library.

Open questions:
- Home's "continue" list labels a text "Continue reading" or "Watch or read again". The reader never stores a position, though, so "continue" always opens at page 1 or at 0:00.
- Home titles a conversation by its topic, falling back to the setting. The conversation shelf always titles it by the setting.

---

### Media library

**Purpose:** the shelf of texts the learner keeps, as a gallery, and three ways to add one more. Internally this is called "reading mode". The learner-facing name is **Media**, because a text can be read, listened to or watched.

Behaviour:
- **Header.** The back link, "Media", and three buttons: *Video*, *Text* and *Write one for me* (*Write* on a phone, where the three share a row under the title). Each opens a **drawer** under the header holding its form; the open one is drawn pressed, and pressing it again — or the drawer's × — closes it.
  - The drawer is in the URL (`/read?tab=video|text|write`); no `tab` is closed, which is how the page opens, even with nothing on the shelf. Home's "or import a text" opens the Text drawer.
  - Each form keeps its own fields and error, and switching or closing drawers keeps what was typed (and a caption fetch in flight).
- **Shelf** ("Your media", with the count). A grid of cards — two columns on a phone, three wide, four on a desktop — in the order the library returns them, newest first. Each card is one link to the reader and shows:
  - a 16:9 tile: a YouTube video's thumbnail; a play glyph on a dark tile for a video file (or a thumbnail that failed to load); for a text with no recording, its opening lines fading out;
  - a badge on the tile: *YouTube*, *Video file*, *Imported* or *Written*; on a video, its duration (the last subtitle's end);
  - the title (two lines at most), its extent ("N lines" for a timed text, "N paragraphs" otherwise) and the date.
  - With no texts, one line points at the buttons above.
- **Filter.** Above the grid when the shelf is not empty: *All · N*, *Videos · N*, *Texts · N*, a video being a text with a recording (YouTube or a file). It is in the URL (`?show=videos|texts`, absent is all), independently of the drawer. A filter that matches nothing says so.

#### Write one for me (generation)
- The learner can type an optional topic (capped at 120 characters) or pick an example chip, then press **Generate**. A hint underneath says either "Written from your N words" or "Your garden is empty, so this one is written from scratch".
- Generation runs as a **background task**. The task both writes the text and saves it, so the text lands on the shelf even if the learner leaves the page.
  - If the Media page is still open when the task finishes, it opens the new text. If the learner has moved on, the text simply waits on the shelf.
  - A retry pressed in the task tray counts the same as the original request: if it succeeds and the page is open, it opens the text; if it fails, the Write drawer shows the failure.
  - While a generation is running, the Generate button reads "Writing…".
- **What the model is given:**
  - the learner's languages and their free-text "about me";
  - the vocabulary as bare terms: garden terms plus any legacy *known* marks, trimmed, deduplicated and capped at 400;
  - up to 12 **focus** words with their meanings, drawn from the words most overdue for review;
  - the optional topic;
  - the level.
- **What the model must write:**
  - a coherent short piece (a story, dialogue, note or short article) at the learner's level, about 6 sentences for a beginner up to about 12 for an advanced learner;
  - built mostly from the vocabulary, using every focus word at least once;
  - a few new words are welcome, but never two in one sentence;
  - a short title in the target language;
  - paragraphs in the target script only, with no readings, translations or notes, and one paragraph per line of speech in a dialogue.
  - The subject is the topic if one was given, otherwise the learner's "about me", otherwise the model's own choice.
- Each paragraph is stored as one untimed segment, the same unit an imported paragraph becomes.

#### Video
- Importing is free and local: there is no model call and no task.
- **A YouTube link** is the primary control. It is checked live; text that names no video says "That is not a YouTube link".
  - Once the link names a video, its caption tracks are listed automatically (see *Fetching captions*), with a spinner while YouTube is asked and the failure inline with "Try again". The same video is never listed twice.
  - Each track is a chip: its name, its language, and an *auto* tag for machine captions. Picking one fetches it.
- **The subtitles** become a **source card**: format (SRT subtitles, WebVTT subtitles, YouTube transcript, YouTube captions), name, line count and duration, with a × to remove it (which brings the chips back). Fetched captions belong to their video and are dropped when the link names a different one.
- **"Or use your own files"**, below and quieter: a video/audio file and a subtitle file (`.srt`, `.vtt`, `.json3`, `.json`, or a `.txt` transcript).
  - A subtitle file is recognised by its *content*, never its extension. A file with no timings is refused, pointing at Text.
  - A local recording needs a subtitle file. A YouTube link may take an uploaded subtitle file instead of a fetched track.
  - The link and the recording file are mutually exclusive: using one clears the other.
  - A chosen file shows "Only its name is kept, so you'll pick the file again when you open this".
- **Title** (optional). It defaults to the video's title, else the uploaded file's name without its extension, else the first line. The default is the field's placeholder.
- **Import** is enabled once there is a recording and timed subtitles. A line under it says what is missing when only half is there. It stores the text and opens it immediately; a file recording is handed to the reader in memory, so the first open plays it without asking.

#### Text
- Just text: a paste box ("Paste an article, a song, a story…") and an "Upload a .txt file" control that puts the file's text in the box. No recording controls.
- One line under it counts what it holds: "3 paragraphs" (or "214 lines" if what was pasted is subtitles, which is accepted as is).
- **Title** (optional), defaulting to the uploaded file's name, else the text's first line cut to 60 characters.
- **Import** stores the text and opens it immediately.

Rules:
- A stored text is **immutable**, and it is **only the text**: title, source (generated or imported), optional topic, optional recording reference, segments, and creation time.
  - Segments are cut the way the source cut them: one per subtitle cue, with its start and end in milliseconds, or one per paragraph, untimed.
  - A segment has both times or neither.
  - No readings, translations, glossary or reading position is ever stored. Everything adaptive is worked out when the text is opened.
- A recording is attached at import and never afterwards. The text can be deleted, but never edited.
- Only a **reference** to a recording is stored: a YouTube video id, or a local file's name and MIME type. Video bytes never enter the store or the synced log.
- Texts sync between paired devices as events. Deleting a text removes it on every device, and a deleted text cannot come back.

Open questions:
- Texts can only be deleted from inside the reader. Conversations can be deleted straight from their shelf.
- Which 400 vocabulary terms the generator sees, for a garden larger than that, is simply the first 400 in storage order. There is no rule.
- Legacy *known* marks still feed the generator as "freely usable" vocabulary, but they do not count toward the level.

---

### Subtitle and text import rules

**Purpose:** turn whatever the learner pastes or uploads into stored segments, deterministically.

Behaviour:
- **Formats recognised:**
  - SRT;
  - WebVTT (the text must start with `WEBVTT`);
  - YouTube's `json3`;
  - text copied from YouTube's "Show transcript" panel: alternating timestamp and text lines, at least two cues, starting on a timestamp. Anything else is prose.
- Detection is deliberately conservative. A pasted article must never be reinterpreted as subtitles because one line looks like a timestamp.
- **Subtitles become one timed segment per cue.** Cues are never joined or re-cut into sentences: a sentence spread over two cues stays two segments, each with the span it was on screen.
- **What cleaning removes:**
  - byte-order marks and Windows/old-Mac line endings;
  - VTT header, NOTE, STYLE and REGION blocks, cue identifiers and settings;
  - every `<…>` tag, including voice spans and per-word timestamps;
  - named HTML entities, which are decoded.
- **Line breaks inside a cue** are joined with a space, or with nothing between two CJK characters.
- **Rolling auto-captions are de-duplicated.** A line is kept the first time it appears and keeps that cue's timing. A cue left empty is dropped. This applies to every format: two consecutive identical lines collapse into one.
- **Orphan blocks:** a block with no timing line, straight after a cue, is folded back into that cue. This happens at the top of auto-captions.
- **Transcript panel:** each cue runs until the next one starts, and the last cue lasts 4 seconds. Text before the first timestamp is ignored.
- **json3:**
  - A cue's pieces are concatenated with nothing in between.
  - Header events and newline-only events are dropped.
  - An event with no duration ends where the next one starts. The final event with no duration lasts 4 seconds.
- **Prose becomes one untimed segment per paragraph.** Paragraphs are split on blank lines and trimmed, and are otherwise kept verbatim, internal line breaks included (songs, poems).
- The import reports the format, cue count, total duration (the furthest cue end) and the segments.

Open questions:
- Collapsing two consecutive identical lines also deletes lines that really are repeated, such as a chorus line sung twice or "No. No." split across two cues.

---

### The reader

**Purpose:** read one text a page at a time, with every word one tap from "what is this?". The colouring and readings reflect what the app knows *today* about each word. Reading is also review for the garden words in the text.

#### Word segmentation and status
- **Segmentation.** The browser's built-in word segmentation is the base. On top of that, the learner's garden terms and legacy known terms win by greedy longest match. So 自行车 stays one tappable word once the learner holds it, even though the segmenter would split it.
  - Punctuation and whitespace are never words.
  - The tokens of a line always rejoin into the exact original text.
- **Spelling match.** Words are matched with one normalisation: trimmed, NFC, lower-cased, internal whitespace collapsed.
  - When several cards share a spelling, this occurrence's own reading (from the local romanizer) picks the card.
  - With no reading to compare, or no card whose reading matches, the first card is used.
- **Three statuses:**
  - **tracked**: in the garden. It shows a soft underline in its maturity colour (sprouting, growing or rooted).
  - **known**: a legacy "I know this" mark. It is not underlined. New marks can no longer be made.
  - **plain**: anything else. It is not underlined, but it is still tappable.
- A garden word already "counted as forgotten" today shows a **dotted** underline in its bed colour.
- A legend above the text explains the underlines.

#### Readings in the prose
- Readings appear as ruby above the word. Only languages with a local romanizer have readings in the prose; today that is Mandarin only.
- Visibility follows the learner's romanization setting, read once when the text is opened:
  - **On:** every reading is shown.
  - **Off:** no readings are shown.
  - **Adaptive:**
    - known words never show a reading;
    - plain words always show one;
    - tracked words hide theirs with a probability that grows with the card's strength.
- **The adaptive roll happens once per card per open.** A word that shows its reading in line two shows it in line nine too. Two cards sharing a spelling roll separately. Adding a word mid-read re-rolls only that new word.

#### Pagination
- A text is split into **pieces**:
  - a segment that fits on a page (30 words or fewer) is one piece;
  - a longer segment is cut into its sentences. That cut exists only on screen and is never stored.
- Pieces are packed greedily into pages of at most 30 words. A page break falls only *between* pieces, and a single over-long piece gets a page to itself.
- Words are counted with the base segmentation, never the garden-aware one, so adding a word can never move a page break.
- Two pieces of the same segment run straight on. Two cues are joined by the script's own gap (a space, or nothing for unspaced scripts). Two paragraphs get a paragraph break. A piece keeps its own line breaks.
- The page number lives in the URL (1-based, clamped to the valid range). Changing page replaces the history entry, so Back returns to the library and scrolls to the top.
- Nothing about the position is stored: opening a text always lands on page 1.
- The finish row shows:
  - "Page N of M";
  - the primary button: **Next page**, or **Finished reading** on the last page;
  - a quiet **Previous page** link, which writes nothing.

#### Tapping a word (the card)
- Tapping a word opens its card in the **panel**. On wide screens the panel is the facing page; on a phone it is a sheet at the foot of the screen. Escape closes it.
- **Every confirmation also lives in the panel**: finishing a page, deleting the text. There are never modal dialogs and never header changes.
- **Every tap:**
  - records a "word looked up" fact (term, text, and the card if tracked);
  - pauses the recording when one is playing.
- **The card shows:**
  - the term;
  - its reading, taken from this occurrence, else from the card's stored reading, *shown whatever the romanization setting is*;
  - a speaker button;
  - a status line: "In your garden · growing", "Counted as forgotten · growing, back sooner", "Marked known" or "Not in your garden".
- **A tracked word's card** shows its meaning and **no actions**.
- **Any other word's card** is built around adding it:
  - **What does this mean?** is the primary button while the word has no looked-up answer and the Meaning field is empty. It steps back to a secondary style once the learner types a meaning, and disappears once there is an answer.
  - Pressing it makes a **paid lookup**, which sends:
    - the word exactly as spelled;
    - the sentence it stands in, cut by the same sentence segmentation as pagination (falling back to the whole segment);
    - the text's title;
    - the level.
  - The reply has two parts:
    - a short **meaning**, a flashcard gloss of a few words in the native language, in this sentence's sense;
    - an optional longer **explanation** (nuance, usage, the grammar of this form).
  - The meaning fills the Meaning field. The explanation is shown read-only above the fields and is never filed.
- **Meaning** and, for words not written in Latin letters (decided from the word's own characters), **Reading** fields are *always editable*.
  - They open prefilled from what is already known: this occurrence's reading, then any answer looked up earlier in this open.
  - A lookup that lands fills only the fields that are still empty, and only on the card that asked for it.
- **A lookup never blocks adding.** While a lookup is running, only its own button is disabled. A failure shows an error line and leaves the fields editable. A learner who knows the word can type a meaning and add it without paying for a call.
- **Add to my words** (enabled once there is a meaning) files the term as spelled in the text, the Meaning field and, if not blank, the Reading field, through the single add-words route.
- For a legacy-known word, the card also offers **Unmark**. Adding a legacy-known word also removes its mark, so the card is the word's only status.
- Looked-up answers are kept for the rest of this open and apply to every occurrence of the word. They are never stored. The text recolours in place after every write, and an open card updates to show the word's new status.

#### Translate
- **Paged view:** a header **Translate** button asks for every segment on the page.
  - It makes one paid call per segment, at most three at a time.
  - Each translation appears under its segment's last piece on the page. A segment split across pages shows its translation on both pages.
  - When every segment on the page is showing, the button reads "Hide translation".
- Each segment's translation succeeds or fails on its own. A hidden answer is kept, and a failed one is asked again the next time it is shown.
- Translations are cleared when another text loads, and they are never stored.
- The translation is faithful enough that the learner can match its parts to the line, and nothing more: no notes, no alternatives.

#### Listen
- **Listen** (paged view only) reads the current page's pieces aloud in order, synthesising ahead to avoid gaps between pieces. Pressing it again (Stop) cuts playback off.
- It is disabled, with a tooltip pointing to Settings, when speech is off. Speech stops when the page turns or the learner leaves.

#### Reading as review
- **A tap on a tracked word is an "Again" review.** This happens only once for that word on this page, and not when the word's last grade today is already Again.
- **Not looking a word up counts as "Good", but only at one explicit moment:** the learner presses Next page or Finished reading, then confirms in the panel.
  - The confirm card states what will be written: "N words read without a lookup count as remembered", plus the looked-up count, or "Nothing new to count on this page".
  - Every tracked word on that page that was not tapped *on that page*, and has not already had a Good today, then gets one Good.
- **Two guards, two purposes:**
  - The per-page "tapped" set lets a word looked up on page one and read fine on page three graduate from relearning.
  - "Not already Good today" stops a word that appears on every page from collecting a Good per page.
- Grade state is worked out from each card's own most recent grade today, so it survives a reload and agrees with drill sessions: a word failed in this morning's drill arrives already counted as forgotten.
- On the last page, a receipt replaces the button. It totals every page confirmed in this open, e.g. "12 garden words read fine · 1 forgotten", or "every garden word here was already reviewed today".
- Plain and known words are never graded. Reading does not affect the streak or the daily count.

#### Delete
- **Delete** (header) confirms in the panel and removes the text on every device.
- A text deleted elsewhere opens as "This text is gone".

Rules:
- The reader owns every write: lookups, reviews, adds, unmarks and deletes.
- A tap is free. Only explicit buttons cost money.
- The text column stays at reading width whatever the screen size. Extra width buys the panel a page of its own, never a longer line.

Open questions:
- The legend reads "new / growing / known", but the card uses the garden's bed names (sprouting / growing / rooted). The legend has no swatch for
  *rooted*. Its "known" swatch is a dotted grey line, the same texture used for "counted as forgotten", while legacy-known words actually carry no mark.
- **Only Mandarin shows readings in the prose.** Japanese, Korean, Russian and every other non-Latin language show none, even for tracked words with a stored reading. The card does show the stored reading.
- **Homograph fallback can grade the wrong card.** Suppose the learner holds only 长 *cháng* and the text uses 长 *zhǎng*. The occurrence still resolves to the *cháng* card, reads as tracked, and is graded Again or Good.
- **There is no lemmatisation.** In spaced languages, an inflected form ("comí" vs "comer") does not match the tracked word. It shows as plain, is never graded, and "Add" files the inflected surface form as a separate card.
- **"Once per day" is approximate.** The Again guard only checks whether the
  *last* grade today is Again. A word graded Good earlier today (say, in a drill) and then tapped gets Again. A word graded Again, then Good, can get a second Again.
- Turning pages by editing `?p=` or using Previous page grades nothing, which is by design for Previous. A learner can also skip grading entirely by leaving without pressing the button.
- Lookups and translations are paid for again on every open, because nothing is cached. The "word looked up" facts are recorded but nothing reads them.
- A tracked word's card has no actions: no editing of its meaning, no removal.
- The learner cannot look up a multi-word span or select a phrase.
- The romanization setting is read once per open, so changing it requires reopening the text.

---

### Follow view (reading along with a recording)

**Purpose:** for a subtitled text with a recording, watch or listen while the line being spoken is shown as tappable, annotated text. This is a *view* of the same reader, not a separate screen.

Behaviour:
- A text with a recording (a file or YouTube) and at least one timed segment opens in the follow view by default.
  - **Read as text** switches to the paged view; **Follow the video** switches back.
  - The view lives in the URL (`?view=text`), and switching resets the page number.
- **Following, the "page" is the segment being spoken.** Annotation, tapping, the card, lookups and lapse grading all work exactly as in the paged view.
- **Current line rule:**
  - The current line is the segment whose start ≤ clock < end; failing that, the last segment to have started. So in a silence the last line stays up.
  - Where cues overlap, one still running beats a later one already over. Of two running, the later start wins.
  - Untimed segments are never landed on.
  - Before the first cue there is no current line, and the screen says "Nothing is being spoken yet — press play, or tap the line below."
- **Phone layout:**
  - the video, sticky at the top;
  - the current line under it, with room for two lines reserved so the layout does not jump;
  - the previous and next lines faint either side, as plain non-tappable text that seeks to that line when pressed;
  - then the controls, then the card sheet.
- **Once the recording is playable, the line is drawn on the picture** as a caption on a dark plate above the player's control bar. It uses the same tappable words with ruby. Without a playable recording, the line stays in the column.
- **Wide layout (48rem and up):**
  - The view fits the screen: the window does not scroll, and the video takes whatever height is left.
  - The facing page is a **transcript**: every segment as a row, the current one highlighted and kept in view, each row a seek-and-play.
  - A word card or confirmation *replaces* the transcript; there is only ever one panel.
  - The transcript is not built at all on phones.
  - The caption matches the picture's measured width, but is never narrower than reading width.
- **Extra-wide layout (72rem and up):** the page width cap is lifted for this view only. The video takes the width and the transcript stays 20–28rem. This is the app's one exception to "width never makes content bigger", and it applies only to a picture.
- **Transport** (line operations a video player lacks):
  - **Previous line** (A);
  - **Replay line** (S or ←): back to the line's start, playing;
  - **Play/Pause** (Space);
  - **Next line** (D or →);
  - **Stop at the end of each line** (Q): auto-pause, off by default and never remembered;
  - **Fullscreen** (F). All are disabled until there is something playable.
- **Keyboard rules:**
  - Space and the arrows stand down when focus is in an input, textarea, button, video, iframe or editable element.
  - The letter keys keep working with a word or button focused, but not in a text field.
  - Escape closes the panel.
- **Fullscreen is the reader's, not the player's.**
  - The player's own fullscreen is disabled. The whole spread goes fullscreen instead: the picture on black, a larger caption, and an open card floating top-right over the picture, plus an exit control.
  - Leaving the follow view leaves fullscreen.
  - The control is not offered where element fullscreen does not exist (iPhone Safari).
- **Translate line** sits under the current line and translates that one segment, pausing playback. The next line starts untranslated, and returning to a line shows its answer again.
- **The clock grades nothing.** The finish row, the Goods and the receipt exist only in the paged view. Listen and the page-level Translate are not shown while following.
- **Native player controls stay on** (scrubbing, volume). The app adds only line-level operations.
- **Position is never stored:** a recording always opens at 0.

#### Local file recordings
- Audio files play through the same video element.
- Because only the file name is stored, the file picked at import is kept in memory for the next open only (for the rest of the browser tab).
- On every later open the stage shows "Choose `<name>` to play it here" with a picker. The line controls stay disabled and Read as text still works.
- A file with a different name is accepted: the learner may have renamed or re-encoded it.

Open questions:
- The follow view grades only lapses (taps). Reading or watching a whole video never credits a Good.
- The `tapped` set never resets in the follow view, because the page never changes there. That is harmless today only because nothing in the follow view grades Good.
- Fullscreen's F key works only as lowercase `f` and only when focus is not on a button. The letter shortcuts work with a button focused.
- There is no playlist support, no start offset from a `t=` link, and no way to attach or replace a recording after import.

---

### YouTube playback and the desktop embed

**Purpose:** play a YouTube recording behind the same player interface as a local file. Neither the reader nor the learner should have to care which kind it is.

Behaviour:
- **A link becomes a video id in exactly one place.** The accepted forms are:
  - URL shapes: `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`, `v/`;
  - hosts: `www.`, `m.`, `music.` and `-nocookie`;
  - with or without a scheme, and with surrounding whitespace;
  - a bare 11-character id. Hosts are matched exactly against a fixed set, never by suffix. Anything else is "not a link yet", which is not an error.
- **Loading and playback:**
  - YouTube's player script loads only when a YouTube text is opened, once per page, using the privacy-enhanced host.
  - Play or seek requests made while it loads are queued and honoured.
  - The clock is polled four times a second, only while playing, and every state change (pause, seek, end) updates the highlight immediately.
- **Failure** shows one line where the picture would be. The text and Read as text are untouched.
  - Failures are: the script fails to load or does not load within 10 seconds, or the player reports an error.
  - Every error code becomes a sentence: invalid id, unplayable, video gone, embedding disallowed by the owner, the configuration refusal (153), or a numbered fallback.
  - Returning to the follow view retries.
- **Keyboard caveat:** once the learner clicks inside the YouTube player, it owns the keyboard. The app accepts this rather than fighting it, and says so under the controls: "Keys work until you click the video."
- **Desktop app:**
  - YouTube refuses to configure a player for the desktop app's own pages (error 153: no web referer). So on the desktop host the video plays inside a small page hosted on a **separate web origin**, framed and driven over a message channel.
  - That page uses the very same player code.
  - The channel carries three commands down (play, pause, seek) and three events up (ready, time with a playing flag, fail). Every message carries a versioned protocol tag. Both sides check the sender's identity and origin.
  - The page validates the video id again and only ever uses it as an id.
  - A page that never answers fails after 10 seconds with the same sentence as a failed load.
  - A desktop build with no embed page configured fails at once with a message naming the missing build setting.

Rules:
- The embed page must never be served from the app's own origin or bundled into the app. It must run on a throwaway origin that holds no learner data.
- Times are milliseconds everywhere above the player implementations.

Open questions:
- The 10-second load timeout is the same for a slow connection and a blocked script, so a slow network can look like a block.

---

### Fetching captions

**Purpose:** a YouTube link alone can produce the text: the app fetches one of the video's caption tracks from YouTube.

Behaviour:
- Available on every host. Once the Video drawer's link names a video, its tracks are listed directly. This is an awaited question, not a background task.
  - Manual tracks come first, then automatic ones, which are marked *auto*.
  - A video with no tracks says so.
  - The list shown is always the current link's: a link naming another video lists that one.
- Picking a track starts a **captions task**, which shows "Asking YouTube", then "Reading <track>".
  - The result is the raw `json3` file. It becomes the source card exactly as an uploaded file would, and the link stays in place, so Import attaches the video as the recording.
  - A track with nothing readable in it fails in the task tray.
  - The task cannot be stopped mid-fetch. The tray offers "Stop watching", which drops the record and leaves the work running.
- **How YouTube is asked:**
  - One implementation in the Rust core asks YouTube's player endpoint for the track list, then fetches the chosen track. No key, cookie or account is involved.
  - YouTube refuses that request from an ordinary web page's origin, so in a browser it goes through a hidden sandboxed frame that may only reach YouTube's own hosts, and sends no credentials. The desktop and Android apps make the requests natively.
  - Only a validated video id is ever sent.
  - On failure, the learner sees what YouTube answered.
- A fetched text syncs like any other import.

Rules:
- The host never parses captions. All parsing happens in the import rules above, so there is one subtitle parser.

---

### Assistant chat

**Purpose:** manage the word list in plain language (add, look up, edit, remove) and get brief tutor answers.

Behaviour:
- **Layout.** A chat screen. The empty state offers three example prompts:
  - "Add the word 'hola' meaning 'hello' to my list";
  - "Which words do I know?";
  - "Clean up duplicates in my vocabulary". Enter sends and Shift+Enter starts a new line.
- **Replies.** Each assistant reply is plain text: one or two short sentences, in the native language, with no markdown and no praise. Below it, one chip per tool call shows a ✓/✗ and a short summary (e.g. "Added 2 words: gato, perro; skipped 1 already in the list").
- **Failure.** A failed send leaves the learner's message in place with an error bubble and **Retry**, which re-sends with the same history.
- **History is ephemeral.** Nothing is stored, so a reload or navigation starts fresh.
- **What the model knows about the learner:** target and native language, level, and word count. The list itself is reached only through tools.
- **Off-topic questions** are answered briefly, as a language tutor.
- **Tool rounds.** Up to 5 tool rounds per message. If the model runs out of rounds without saying anything, the reply is "I made the changes I could; ask me again if something is missing."
- **Earlier turns** travel to the model as prose only. The model does not see its previous tool calls or their results.

#### Assistant tools (shared with other features)
Every change goes through the store's repositories, so every change is an event and syncs.
- **add_words** takes 1–50 words. Each word has a term and a meaning (both required), plus optional reading, notes, and kind (vocab by default, or grammar).
  - New cards start fresh, scheduled from now.
  - **Deduplication is by card**, against the list and within the batch. Same spelling plus readings that do not tell the two apart counts as the same card. A word with *no* reading collides with every card of that spelling, and so does an existing card without a reading.
  - Duplicates are skipped and reported, never treated as errors.
  - This is **the only route by which vocabulary enters the garden**. The reader's Add, Check what you know and conversation mode all use it.
- **list_words** takes an optional query (matched against term, meaning and reading) and a limit (default 50, maximum 200). It returns term, meaning, reading, notes and review count, plus the total.
- **update_word** changes the term, meaning, reading or notes of one word, named by its exact term plus, for homographs, its reading.
  - Omitted fields stay as they are; an empty string clears the reading or notes.
  - It never touches the schedule or review history.
  - It refuses an edit that would make the word collide with another card.
- **remove_word** removes one word (and its review history) by exact term plus reading for homographs. This is irreversible. The prompt forbids it unless the learner explicitly confirmed that word in this conversation.
- **Errors go back to the model.** An ambiguous homograph without a reading, a missing word, bad arguments or an unknown tool is returned to the model as an error result that it can read and recover from. Only a store failure ends the turn.
- **Non-Latin targets:** the prompt requires a reading on every word added.

Open questions:
- **Deletion has no UI confirmation.** The only guard is the prompt's "confirm first" rule. Because earlier turns are replayed as prose without tool results, "confirmed in this conversation" depends on what the model wrote.
- The "Clean up duplicates" example promises something add_words already prevents, and there is no merge tool. Cleanup can only mean removing words one by one.
- "Which words do I know?" cannot be answered meaningfully: list_words exposes no strength or due information, and legacy known marks are invisible to it.
- A list larger than 200 words cannot be read in one call, and the order of the list is unspecified.
- update_word can rename a term while keeping its history. It cannot change a word's kind.
- The chat has no dictation and no speech output, unlike conversation mode. The learner's "about me" is not used.

---

### Conversation mode

**Purpose:** a role-played conversation with an LLM teacher in the target language. It builds comprehension and production, quietly corrects real language mistakes, and grows the word list from words the learner has *shown* they can use.

#### Library and start
- **Layout.** The start card sits opposite a shelf ("Your conversations"). On a phone the start card comes first.
- **Start card.** An optional "What about?" topic (placeholder "Leave it blank and I'll pick a scene"), example chips, and **Start** ("Setting the scene…").
- **Start makes one paid scene call.** It is given the level (from the garden size at the moment of pressing), the languages and the topic (capped at 120 characters). It returns:
  - the setting (one sentence) and two short roles, the teacher's and the learner's, in the **native** language;
  - who speaks first;
  - if the teacher speaks first, an opening line in the target language with its reading and a native translation. A malformed scene is an error ("…unexpected shape. Try again.").
- **Writes on start.** The conversation is stored. If there is an opener, it is stored as exchange 0 (a teacher line with no learner half). Then the conversation opens.
- **Shelf rows** show the setting, a topic badge, the date of the last turn and the turn count, plus **Delete**. Delete is a two-step inline confirm: "Gone for good, on every device." with "Delete for good" or "Keep it".

#### The conversation screen
- **Scene card** at the top: the setting, "You are **<learner role>**." and "I am **<teacher role>**."
- **Teacher bubbles:**
  - the line in the target language, with a speaker button;
  - its reading underneath, when there is one;
  - **Show translation** (tap to reveal);
  - chips for any words the teacher added to the list.
- **Learner bubbles:** what the learner typed.
  - **When a correction came back:**
    - the changed spans are marked inline (removed, then added) and the note is shown quietly underneath;
    - if the learner typed a romanization, the markup runs against the corrected *reading*, and the corrected sentence in the target script is shown under the bubble with a speaker button.
  - **When no correction came back but `heard` did:** the learner's own sentence, written properly in the target script, is shown in the same place with a speaker button. Seeing the script must not depend on making a mistake.
  - Both arrive with the teacher's reply, so the learner bubble updates in place.
- **Composer.** "Reply in <language>…", with Enter to send. A **microphone** button appears only where dictation works for this language.
- **Failure.** A failed send leaves the bubble and offers Retry.

#### The teacher's contract
- **Stays in character.** Speaks only the target language, plays only its own role, and never writes the learner's lines.
- **Reply length** follows the level:
  - beginner/elementary: one short sentence and one short question;
  - intermediate: one or two sentences and a question;
  - advanced: two or three sentences and a question. Always one thing at a time.
- **Vocabulary.**
  - The learner's newest 200 words (term, reading, meaning) go into the teacher's instructions.
  - The reply is built from those words plus the most common words of the target language, with at most one word outside the list per reply, and only when the scene needs it.
  - With an empty list, only the most common words.
- **Romanized input is legitimate.** It is read phonetically and generously (spelling, spacing, tone marks) and never corrected for being romanized. Mixed script and romanization is fine too.
  - When the teacher cannot tell what was meant, it asks, in character, rather than inventing a message.
- **Corrections cover language, never content:** grammar, spelling, agreement, endings, non-existent words or impossible usage.
  - Ordering pizza in an ice-cream shop gets an in-character answer and no correction.
  - The correction is **the smallest edit that keeps the learner's meaning**, even when that meaning is odd or rude.
  - When in doubt, there is no correction.
  - The corrected version is the learner's *whole* message rewritten, with a reading. The note is one short native sentence.
  - Corrections never appear in the spoken reply.
- **`heard`** is the learner's message in proper target script. It is given whenever any part of what they typed was not already in the script, and never for Latin-script targets.
- **Correction and heard are exclusive:**
  - A surviving correction wins, and heard is dropped.
  - A correction that changes nothing is dropped and becomes heard instead. "Changes nothing" means identical to what was typed, or matching the corrected reading once case, tone marks, apostrophes, hyphens and spacing are ignored.
  - A heard line identical to what was typed is dropped.
- **Adding words.** The teacher has exactly one tool, **add_words**. It may use it only for a word that appears in the learner's own message, is not already in the list, and was used correctly. Never for words the teacher introduced or words the learner got wrong. Words added are shown as chips on the teacher bubble.
- **Tool rounds.** At most two per turn, and the final round offers no tool, so the teacher always ends up saying something.
- **Malformed replies.** A reply that is plain prose instead of the expected structure becomes the spoken line, with no translation or correction. A broken structured reply becomes "…" (a pause). The raw structure is never shown.

#### Correction markup rules
- **The unit of the diff is what the script delimits.** Han, kana, Thai, Lao, Khmer and Myanmar are compared one character at a time; everything else word by word on whitespace. Hangul counts as spaced.
- Spans are rejoined without inventing spaces in unspaced scripts.
- **The markup aligns against the reading when the message is *mostly* Latin letters and the corrected text contains non-Latin letters.** Against a reading the comparison is loosened: case, tone marks and apostrophes are ignored.
- In the target language's own spelling every mark counts. French *ecole* for
  *école* is a real correction.
- Comparison is otherwise exact, including capitals.

#### Persistence and sync
- **A conversation is append-only.** There is no editing, regenerating or scene switching.
- **The unit stored is the exchange:** a learner message and the teacher reply that answered it, written together after the reply lands, with heard and correction stored on the learner half.
  - A message whose reply failed is never stored, so stored history always ends on a teacher line.
- Each exchange is identified by conversation plus index. The same exchange arriving twice is kept once.
  - An exchange arriving before its conversation is still kept.
  - Deleting a conversation is permanent on every device.
- **Resuming** replays history as dialogue: learner turns exactly as typed, and teacher turns with the heard and correction they gave.
- A conversation deleted elsewhere opens as "This conversation is gone".

Open questions:
- The learner's "about me" is used nowhere in conversation mode. The area's own description calls it "the one personalisation".
- The teacher's reading is always shown, whatever the romanization setting. The teacher's words are not tappable, not looked up and not addable by the learner. The learner's script line shows no reading at all.
- Revealed translations are not remembered. A failed, unsent message is lost on leaving the page.
- There is no delete or rename from inside a conversation, and no title. The shelf shows the setting and home shows the topic.
- **Corrections of capitals and punctuation only.** For Latin-script targets these survive as corrections, even though the prompt scopes corrections to grammar and spelling. Punctuation sticks to its word in the diff, so a comma marks the whole word as changed.
- Conversation grades nothing. Tracked words the learner uses correctly get no review credit, and only *new* words are ever recorded.
- **Two devices continuing the same conversation at once.** Both write the same exchange index, one exchange is kept and the other is silently lost.
- Dictation behaves differently by host. In a browser, interim words stream into the composer. The desktop recognizer delivers one final transcript.

---

### Romanization (readings)

**Purpose:** show readings computed locally, per word, rather than relying on the model's one flat string per sentence.

Rules:
- Romanizers exist per language and are loaded lazily, so only learners of that language download the dictionary. Today only **Mandarin (pinyin)** exists. Cantonese is deliberately excluded (jyutping is not pinyin). Unknown languages get none.
- **Never romanize a term on its own.** The whole line is romanized and the readings are sliced per character, because context resolves polyphones (银行 *háng* vs 自行车 *xíng*).
- Tokens are grouped around the learner's terms, so a tracked word comes back as one token with its whole reading.
- **In running text** (the reader, challenges), the romanization setting (on, off or adaptive) decides visibility.
- **For a word on its own** (the word card, the garden list), the reading is always shown. In the garden list the *stored* reading is authoritative, since it is the only thing that tells homographs apart.
- A language without a local romanizer falls back to the readings the model wrote, where those exist. Reading-mode texts store none, so for those languages the reader shows no readings in the prose.
- A missing stored reading is never filled in automatically.

Open questions:
- Readings in reading mode are effectively Mandarin-only (see the reader). The spec does not say whether other languages should get a local romanizer, or should fall back to readings the model provides.

---

### Speech output and dictation in these features

**Purpose:** hearing the target language, and speaking replies, without either ever blocking the experience.

Behaviour:
- **Speaker buttons** appear on:
  - the reader's word card;
  - conversation teacher lines;
  - conversation script lines (corrected or heard).
- A speaker button is always rendered. It is disabled, with a pointer to Settings, when speech is off or the text is blank.
- **Reader Listen** reads the page aloud, piece by piece (see the reader).
- **Engines:**
  - Mandarin and English use the high-quality Kokoro voice. It runs in the browser, or natively on the desktop and Android hosts.
  - Every other language uses the browser's built-in speech.
- **Audio failures fail silently.** Sound never blocks reading or conversation. Leaving a page stops speech.
- **Dictation** exists in conversation mode only.
  - The control appears only where recognition works for that language: the desktop host's own recognizer for the languages it covers, or the browser's speech recognition. There is none in Firefox, the Linux desktop webview without the host recognizer, or the Android WebView.
  - **The transcript lands in the composer, never in a sent message.** The learner reads it and presses Send, so a misheard word is a typo they fix, not a mistake the teacher corrects.
  - Sending while dictating takes what is already in the composer and stops the microphone.
  - "No speech" and "aborted" end silently. Only microphone problems the learner can fix show an error line. When dictation cannot start, the message is "Dictation could not start. Type your reply instead."
  - Dictated text is joined to existing text with the script's own spacing rule.

Rules:
- No path may send a dictated transcript unread.
- The fallback for missing recognition is typing, never another engine.

---

### Cross-cutting rules for this area

- **Stateless helpers, page-owned writes.** The reading, media and conversation logic never touches the store. The pages perform every write, through repositories that produce synced events.
- **Mock mode** makes every feature here fully usable without a key:
  - a fixed generated text (Spanish or Mandarin);
  - placeholder lookups;
  - a fixed Spanish ice-cream scene, whose teacher corrects the second message and gives a heard line on the third;
  - a chat that turns `term = meaning` lines into real add-words calls and answers "list"-style questions with a real list call.
- **Limits:**
  - topic: 120 characters;
  - generator vocabulary: 400 terms;
  - focus words: 12;
  - conversation word context: the newest 200 words;
  - add_words: 50 words per call;
  - list_words: default 50, maximum 200;
  - chat tool rounds: 5; conversation tool rounds: 2;
  - page size: 30 words;
  - translate concurrency: 3;
  - YouTube load timeout: 10 seconds;
  - default length of an open-ended last cue: 4 seconds.
- **Layout:** mobile-first with exactly two breakpoints (48rem, 72rem). Every sub-route renders a back link to its parent.

---

## Part 3 — Platform, data and hosts

What the learner's data is, where it lives, how it survives and moves between devices, device settings, background work, speech in and out, the hosts, and the layout rules every screen follows.

### Learner data

**Purpose:** All of a learner's progress is a log of facts they produced. Everything the app shows is derived from that log, so the log is the one thing that must never be lost, rewritten or mis-merged.

#### What the learner's data consists of

- **The event log** is the source of truth. Each entry records one thing that happened: an id, a type, the moment it happened (`at`), the device it happened on, and a payload. Kinds of fact:
  - Vocabulary: a word or grammar item added, edited (a patch of its fields), deleted, reviewed (one graded review), or re-graded.
  - Challenge pool: a generated challenge added, served, reported (permanently excluded); an answer logged; an answer overturned after a successful dispute.
  - Profile: the whole language profile replaced.
  - Reading: a text added or deleted; a word marked; a word looked up.
  - Conversation: a role-play started, a turn added, a conversation deleted.
- **Derived state**, always rebuilt from the log and never synced or exported as such: each word's spaced-repetition card and schedule (due date, retrievability, a display-only strength), each word's learned skill and each challenge's learned difficulty correction, the shared difficulty parameters, per-day activity, the text library, conversation transcripts.
- **Device-local state**, which is not learner data and never enters the log, sync or export: the LLM API key, endpoint, model and generation settings, display and speech preferences, the sync phrase and switch, the last sync outcome, token-usage counters, the device id, and the cached voice and recognizer models and audio clips.

#### Behaviour

- Every change the learner makes is written as one or more events, applied at once, in one transaction per action. A failure rolls the whole action back.
- Reads always come from the derived state and never scan the log directly.
- Schedule numbers are a snapshot taken when a screen reads them. A screen left open past a due date shows the old schedule until it reads again (on navigation).
- "Day" means the learner's local calendar day.

#### Guarantees and invariants

- **Append-only.** Facts are never edited in place. A correction is a new fact (re-grade, patch, tombstone, overturn).
- **Deterministic derivation.** The same set of events gives the same derived state, whatever order the events arrived in. Overwrite facts use last-write-wins by `at`. Item patches fold per field in `(at, device)` order. Learned difficulty numbers are replayed in `(at, id)` order and must come out bit-identical whichever way they were computed. A small set of documented cases depends on log order (a serve or report that arrives before its challenge, a re-grade that arrives before the review it replaces).
- **Idempotent.** An event id already in the log is never applied a second time.
- **Total.** Applying an event never fails. A fact that cannot apply yet (a review for a word not yet added, a patch before its add) is kept and takes effect when its prerequisite arrives.
- **Tombstones win.** A deleted word and its reviews are gone for good. A later add with the same id is ignored.
- **Forward compatibility.** An event this build does not understand (unknown type, or a newer payload shape) is still stored, pushed, pulled and exported unchanged. It is only skipped when derived state is built. An older device must never be where newer facts get lost.
- **Payloads only grow.** Stored shapes take new optional fields only. Every row ever written must still parse. A renamed field is read under its old name too.
- **Content-derived ids.** Any id that crosses devices comes from synced content, never from something device-local.
- A change to how derived state is computed rebuilds it from the log. It never reinterprets or rewrites stored facts.

#### Open questions

- The sync documentation's event table lists 10 event types, but the product has 19 (reading, conversation, lookups, overturns and study spans are missing from it). Which list is the contract?
- The profile stores a `model` field, and the model is also a device-local setting. Onboarding writes both. Settings writes only the local one. Which copy wins, and should the profile carry it at all?
- The profile still writes deprecated `level` and `interests` values, kept only so older builds can parse it. When can these be dropped?

---

### Languages (multiple gardens)

**Purpose:** One learner can study several target languages on one device. Each has its own word list, pool, texts and history.

#### Behaviour

- The "More" menu in the main navigation has a **Language garden** row that shows the active language. Opening it lists every language profile ("X from Y"), with a check on the active one, plus an **Add another language** entry.
- Adding a language runs onboarding in "add" mode. The API key and model steps are skipped when a key is already stored. The new profile becomes active.
- Switching language makes the chosen profile active on **this device only** and reloads the app at Today.
- The log holds every language. The derived state holds only the active one and is rebuilt from that language's events on each switch.
- Facts for the first (original) language use the plain event shapes. Facts for any added language travel wrapped in a scoped event that names the profile. A build that predates multiple languages keeps and relays these wrapped events but never applies them to its single library.
- Export, import, sync and reset all act on every language at once.

#### Guarantees

- Which language is active is device-local and never syncs.
- A language added on one device appears in the list on every paired device.

#### Open questions

- A language profile cannot be deleted or renamed, and its target language is shown read-only in Settings. Is that intended?
- Onboarding in "add" mode has no back link on its first step. The rule allows that for first run, but for "add" there is an app to go back to.
- The first language and added languages are stored asymmetrically (plain events versus scoped events). Should a rewrite keep this distinction or unify the two?

---

### Storage and durability per host

**Purpose:** The local database is the product. It must open reliably, persist across restarts, and fail loudly instead of silently starting empty.

#### Behaviour

- **Web:** SQLite in the browser's origin-private file system (OPFS), run off the main thread. The UI talks to it only in domain operations, never SQL.
- **Only one tab may hold the database.** A second tab shows "Sapling is already open in another tab." and stops. There is no leader election and no read-only mode.
- **Desktop and Android:** a native SQLite file in the app's per-user data directory (for example `~/.local/share/app.sapling.desktop/` on Linux, private app storage on Android), opened in WAL mode. An app crash loses nothing. A power cut can lose at most the last transaction. Deleting that directory is a factory reset.
- If the database cannot open (no OPFS, held by another tab, permission problem, corrupt file), the app shows a full-screen boot error with the reason. It never falls back to an empty or in-memory store.
- At boot, if there is no profile and sync is on, the app pulls from sync once before deciding the learner needs onboarding.

#### Guarantees

- No learner data lives outside the local database. That is why reloading the app, for example to heal from a stale deploy, is always safe.
- The same domain operations, merge rules and derived state run on every host. Only the storage layer differs.

#### Open questions

- The web build never requests persistent storage, so the browser may evict OPFS under storage pressure. For a local-first app that is the main data-loss risk. Should the app request persistence, or warn when it is not granted?
- The device id is half of a review's identity. In a browser it lives in localStorage and Reset wipes it, so the next review carries a new device id. On desktop it is a file that survives Reset. Which behaviour is intended?

---

### Export, import and reset

**Purpose:** The learner can take a complete backup, restore it, or wipe the device.

#### Behaviour

- **Export progress** downloads `language-learning-backup-YYYY-MM-DD.json`. It contains the whole event log, every language, exactly as stored (including events this build does not understand), plus a version and a timestamp. No device-local settings are included: no API key, no preferences, no sync phrase.
- **Import progress** takes a JSON file and asks for confirmation ("Importing a backup replaces all current progress on this device. Continue?"). Then:
  - A current-format backup is **merged** into the log (union by event id; events already present are skipped) and all derived state is rebuilt.
  - Older-format backups (a word list plus a profile) replace the word list wholesale (each existing word is tombstoned) and replace the profile.
  - Unreadable files or unsupported versions show an inline error and change nothing.
  - The app reloads when the import succeeds.
- **Reset all progress** (in the Danger zone) needs the learner to type `RESET`. It empties the whole database (log included), removes every device-local setting (API key, preferences, sync phrase and switch, usage counters, device id), and returns to `/`, which leads to onboarding.

#### Guarantees

- An export plus an import onto an empty device reproduces the same derived state.
- Importing the same backup twice changes nothing.

#### Open questions

- **The copy disagrees with what import does.** The confirm dialog and the hint say import "replaces everything". A current backup is actually merged, and nothing local is removed. Which is meant?
- Reset is local only. Data already synced stays in the sync room. Re-pairing with the same phrase, or any other paired device, brings it all back, and Reset never says so. Is there meant to be a remote wipe?
- Reset leaves the downloaded voice and recognizer models and the audio clip cache in place. That is probably right, but it is not stated anywhere.
- The backup filename uses the repo name (`language-learning-…`), not the product name.

---

### Sync

**Purpose:** Opt-in replication of the event log between a learner's devices through a relay that orders events and never interprets them. The app must be fully usable with sync off, unconfigured or unreachable.

#### Behaviour

- **Availability is per build.** A build without a sync server configured says "This build has no sync server; everything stays on this device." and offers nothing else.
- **Opt-in per device.** Sync is off until the learner turns on **Sync this device**. Turning it on mints a pairing phrase if the device has none. Turning it off keeps the phrase, so turning it back on rejoins the same library.
- **Pairing phrase:** 20 characters of Crockford base32 (100 bits), shown in four groups of five (`ABCDE-FGHJK-MNPQR-STVWX`). It is a credential ("Treat it like a password"): masked by default, with **Show/Hide**, **Copy** (if the clipboard is refused, the phrase is shown instead), and **Unpair** (forgets the phrase, turns sync off, and leaves local data alone).
- **Typed phrases are forgiving:** case-insensitive, separators and other symbols ignored, `I`/`L` read as `1` and `O` as `0`. Anything that does not normalise to exactly 20 valid characters is rejected with a message.
- **Pairing a second device:**
  - *From onboarding* (a fresh device): enter the phrase. The device runs one sync and enters the app only if a profile came down. Otherwise it says "Nothing there yet — turn sync on for your other device, then try again." Pairing never writes a profile, so a joining device cannot overwrite the real one.
  - *From Settings* (a device that already has data): enter the phrase. If it differs from the current phrase, the learner must confirm ("This device will follow that library instead, and everything on it joins that library."). Following a different library — from Settings, onboarding or anywhere the phrase changes — sends that library everything on this device and pulls it from the start; the two merge.
- **When sync runs:** at boot (after the first render, never blocking it), when the tab is hidden or becomes visible again, at the end of a practice session, on leaving a text, and on **Sync now**. Nothing runs on a timer. Every trigger but **Sync now** runs every set-up remote at once — sync first, then Taal, so what another device did reaches the leaderboard on the same trigger. A trigger while a cycle runs queues exactly one more behind it; later ones join that one.
- **One cycle:** push every unacknowledged local event in pages, then pull everything newer than the stored cursor, applying each page before the cursor moves past it.
- **Feedback:** Settings shows a live **Connection** check, run on open and on **Check again**, that can tell a refused phrase from an unreachable server. It also shows "Last sync <time> — <message>" for the last cycle, whoever started it.
- **Conflicts as the learner sees them:** none to resolve. Every fact from every device is kept, reviews from two devices on the same word both count, a deletion wins over any edit, profile and item edits are last-write-wins by when they happened, and the end state is identical on every device once each has synced.

#### Guarantees

- **Local-first:** every failure (offline, refused phrase, server error, store error) becomes an outcome message. None of them is an error that interrupts the learner. The app never waits on sync.
- **No loss on interruption:** an event stays unacknowledged until the relay answers for it, and the cursor never passes an unapplied page. An interrupted cycle costs a repeated request, never an event.
- **The relay is payload-blind:** it assigns each event a sequence number, stores it, and returns events in that order. It never merges, validates or reads a payload. Two devices with the same phrase share one room. The room is named by a hash of the normalised phrase, and the relay never stores the phrase itself. A deployment can be limited to a list of allowed phrases.
- **The phrase rules must be identical on client and relay.** If the two normalise differently, a second device lands in an empty room, which looks like lost data.
- Only the event log syncs. Settings, keys, models, caches, the active language and the last sync outcome never leave the device.

#### Open questions

- **Privacy:** payloads cross the network and sit on the relay as plain JSON: every word, answer, text and conversation. Whoever runs the relay can read them. Is that acceptable, or should payloads be end-to-end encrypted with a key derived from the phrase? (The relay never needs to read them.)
- **"Reload now" may be unnecessary.** Turning sync on or off, pairing and unpairing all say the change applies "after reload". Each cycle reads the switch and phrase when it starts, so the reload looks like a leftover from an older architecture.
- Nothing can be deleted from a relay room, and rooms never expire. There is no "leave and erase" for a phrase.
- No sync runs on a timer, so a device left open in the foreground never pulls on its own.
- The desktop and Android builds use the same sync URL as the web build, and that path was never exercised on them.

---

### Settings

**Purpose:** One page for every device-level choice and every action on the learner's data. Settings changes apply right away unless noted.

The page has a back link to Today and lays out its cards in two balanced columns on wide screens. Linking to a field (for example `/settings#settings-api-key` from the home screen's "Add a key") scrolls to it and focuses it once the page loads. The cards, in order:

1. **Profile:** read-only "Learning <target> from <native>" plus an "Edit about you" link to `/profile`; when the target language resolves to no tag, a line saying voice, dictation and readings are off, linking to `/profile` to choose it.
2. **Display**
   - *Appearance:* System / Light / Dark (default System; System follows the device and updates live).
   - *Pronunciation (romanization):* Off / On / Adaptive (default On; Adaptive fades the reading as a word sticks).
   - *Listening challenges:* on/off (default on; some prompts are spoken instead of shown).
3. **Speech**
   - *Voice engine:* "Sherpa neural voices" (default) / "Browser built-in" / "Off". Hints say which languages the neural voice covers, and when the learner's language is not covered.
   - *Mandarin voice* (shown only for a Mandarin learner with the neural engine): Default (zf_001, female), zf_018 female, zm_010 male.
   - *Download the voice* (shown with the neural engine): starts the voice-model background task. "Downloads N MB once, then works offline". The size is asked of the host, so the web and native downloads report their own sizes.
   - *Dictation* (shown only on a host with a downloadable recognizer, which means desktop and Android): its size, whether it is installed, a note when the learner's language is not covered ("the microphone button stays hidden"), and a Download button that becomes "Downloaded".
   - *Audio cache:* "X of 100 MB" with **Clear audio cache**. This clears stored clips only, never the voice model. Hidden on native hosts unless something is actually stored.
   - A *Test voices* link to `/tts-test`.
4. **Language model**
   - *API key:* a password field. A saved key shows "••• saved", and a blank field keeps the saved key. "The key stays in this browser."
   - **Connect OpenRouter** (only while the endpoint is blank or OpenRouter): gets a key by OpenRouter's sign-in and saves it at once, shown as "Connected". A browser signs in in a popup; the desktop and Android apps sign in in the system browser, which returns to the app. A blocked popup, or an app that cannot open the browser, shows a link and a field for the code OpenRouter displays. A failed exchange says so in a line ("That code expired or was already used — try again.").
   - *Model:* free text with suggestions. Defaults to a built-in model.
   - *API endpoint:* optional. Blank means OpenRouter.
   - **Apply** saves all three together.
5. **Lesson generation**
   - *Reasoning effort:* Provider default / Minimal / Low (default) / Medium / High / Max.
   - *Challenges per request:* 1 to 24, blank means the built-in default. An out-of-range value is cleared rather than clamped. Each challenge type is still a separate request.
6. **Usage:** request, prompt-token and completion-token counters for this device. "Cost depends on your model."
7. **Sync:** see Sync above.
8. **Data:** Export progress and Import progress. See Export, import and reset above.
9. **Danger zone:** Reset all progress, confirmed by typing RESET.

#### Guarantees

- All of the above is device-local. None of it enters the log, an export or sync. The API key goes only to the configured endpoint.
- Every action reports one inline line of outcome. A download shows button state only, and its progress lives in the task tray.

#### Open questions

- There is no visible way to turn on mock (fixture) mode. It is a hidden flag, plus an automatic fallback when no key is set. Should it be a setting?
- English learners get a fixed English voice and no voice choice. Only Mandarin has a voice picker.
- The usage counters cannot be reset on their own (only through Reset all progress), and they track tokens with no cost estimate.
- Settings shows the voice download (and its size) for the active language only. A learner with several languages gets no view of which voices are installed.
- An "Off" voice engine leaves the Listening challenges switch on. What happens to spoken prompts then is not defined here.

---

### Background tasks

**Purpose:** Every long job has one lifecycle and one place to watch it, so leaving a page never loses track of the work.

#### Behaviour

- **Task kinds:** challenge top-up (generating the pool), generating a reading text, downloading the voice model, downloading the dictation model, and fetching a video's captions (desktop only).
- **Lifecycle:** a task is queued, then running, then ends as done, failed or cancelled. Kinds that must not overlap (top-up, text generation, the two model downloads) run one at a time and queue the rest. Different kinds run in parallel. Fetching captions has no such limit.
- **The tray** shows nothing until a task exists. Then a pill sits at the bottom right ("N running", or a check or cross once everything is settled), above the mobile navigation bar. Tapping it opens a list: a bottom sheet on phones, a corner card on wide screens. Each row shows a title, a status, either a step ledger with a ticking clock or a progress bar, a summary or error, and **Cancel** (worded "Stop watching" for jobs that cannot really be stopped), **Retry** and **Dismiss**. Settled tasks can be dismissed together.
- A focused screen (a challenge in play) can hide the tray, and brings it back when it leaves.
- **Pages show only their button state** ("Generating…", "Downloading…") and one line of outcome. All other detail is the tray's.
- **Cancel** settles the task at once. A result that arrives after that is thrown away.
- **Retry** re-runs the saved input as a new task. A page that started the original also follows its retries.
- At most 20 settled tasks are kept.

#### Guarantees

- Tasks live in memory. A reload clears the tray, but nothing a task produced is lost, because results are saved through the normal data path the moment the task finishes (pool rows, a saved text, models on disk). Fetched captions are the exception: they are not saved until the learner imports them.
- A task never surfaces as an unhandled error. Every task ends with an outcome.

#### Open questions

- The voice download cannot be cancelled ("Stop watching" only). The download itself keeps running.
- The first neural-voice use outside the task (a tap on a speaker icon, the pre-render when a challenge appears, the test bench) appears to start the same multi-hundred-megabyte download implicitly, with no tray entry. Should an implicit download ever happen?

---

### Speech output (TTS)

**Purpose:** Speak target-language text at the tap of a button and for listening prompts, without ever blocking play.

#### Behaviour

- **Three engine choices:** neural (default), browser built-in, off.
- **Neural voices:** Kokoro multi-language for Mandarin and English (Mandarin has three selectable speakers), and a separate VITS model for Cantonese. Every other language uses the browser's voice even when neural is selected.
- **Web:** the neural engine runs in the page. Its model files (about 439 MB for Kokoro) are fetched once from a pinned mirror and cached, then work offline. Synthesized clips are kept in an in-memory cache for the session and a 100 MB on-disk clip cache.
- **Desktop:** the same voices run natively from k2-fsa's own release archives (365 MB Kokoro, 108 MB Cantonese, checked against pinned sizes and checksums). The host plays the audio itself, for low latency. There is no on-disk clip cache, because re-synthesising is cheap.
- **Android:** native synthesis as on desktop. Playback goes through the webview's ordinary audio element.
- When a challenge appears, its audio is synthesized ahead of time, so playback is instant when feedback auto-plays.
- A new phrase cuts off the one playing.

#### Guarantees

- **Audio never blocks gameplay.** Any failure (no model, a download still running, a crash, refused autoplay, no output device) falls back to the browser voice and then to silence. The learner never sees an error.
- One model gives one sound: the same voice and speaker ids on every host.
- Deploys and service-worker updates never delete the downloaded voice models or clips.

#### Open questions

- The engine is labelled "Sherpa neural voices", which names the runtime rather than the voice.
- On the web, Cantonese download sizes and the "Download the voice" copy are worked out per language. A learner who switches between Mandarin and Cantonese has to download a second model, and Settings never says so.

---

### Dictation (speech recognition)

**Purpose:** An input method for typed answers and chat. It is never a grader.

#### Behaviour

- A microphone control appears only where recognition is available for the learner's language. Otherwise there is no control, and typing is the fallback. No alternative engine is offered.
- **Web:** the browser's Web Speech recognizer, where it exists (not Firefox, not WebKitGTK, not Android WebView).
- **Desktop and Android:** a native recognizer (SenseVoice, a 163 MB download, Mandarin, English, Japanese, Korean and Cantonese), downloaded from Settings. Audio is captured in the page and recognized on the device.
- The transcript is placed into the composer for the learner to read, edit and send.
- Silence, very short audio or a cancelled recording ends quietly. Only a microphone problem the learner can fix (for example, permission denied) shows a message.

#### Guarantees

- **No path ever sends a transcript unread.**
- On desktop and Android, recognition happens entirely on the device. The web recognizer is the browser vendor's and may be a network service.
- The recording never reaches the speakers.

#### Open questions

- Android dictation (the permission flow, speed on a phone CPU) has never been verified on a device.
- The web recognizer may send audio to the browser vendor. Is that acceptable for a privacy-first product, and should the app say so?

---

### Voice test bench (`/tts-test`)

**Purpose:** A scratch page to try the voice with any text and language, outside a lesson.

#### Behaviour

- A text box, pre-filled with a Chinese or English sample depending on the profile.
- Language chips: Chinese, English, plus the learner's own target language.
- A Mandarin voice picker, shown only when it applies. It shares the stored preference with Settings.
- The engine that will actually speak is labelled.
- Speak and Stop buttons, with status: synthesizing, model download percentage, time taken, or an error.
- A back link to Settings. No main navigation is shown.

#### Open questions

- Is this a product feature or a developer tool? It is linked from Settings as "Test voices", but it describes itself as "a scratch surface, not a feature", and it can trigger the full voice download outside the task tray.

---

### Web host (PWA)

**Purpose:** The primary host: a static single-page app that installs, launches offline and survives deploys.

#### Behaviour

- **Installable:** the web manifest is named "Sapling" and is standalone with a portrait orientation preference. Install through the browser's install control, or on iOS through Share, then Add to Home Screen.
- **Offline launch:** the service worker pre-caches the app shell and static files. Navigations try the network first and fall back to the cached shell. Hashed build assets are cache-first and are also picked up on first fetch, which covers assets missing from the pre-cache list such as the database worker and its wasm.
- **What works offline:** everything except generating new challenges or texts, dispute escalation, chat and conversation, the first voice download, and anything YouTube.
- **Stale tab after a deploy:** if a page fails to load a code chunk that no longer exists, the app reloads once into the new build, and reloads again only after the learner has successfully navigated somewhere.
- **External calls**, and the only ones: the LLM endpoint with the learner's own key, the optional sync relay, the voice-model mirror, and YouTube's player.

#### Guarantees (deploy)

- **A missing hashed build asset returns a real 404 and is never served as the app shell.** Otherwise a stale request could poison an immutably cached URL for every visitor.
- Every other unknown path serves the app shell, so a deep link or hard refresh works.
- Hashed assets are cached as immutable. No cross-origin isolation headers and no CSP are set. Any future CSP must allow YouTube's player script, the youtube-nocookie frame, and the library's thumbnails from `i.ytimg.com`.
- A new deploy takes effect without closing tabs. Deploy cleanup only ever deletes the app's own shell caches.
- The YouTube embed page for desktop is hosted on a separate origin from the app, never alongside it, so a page anyone may frame never shares an origin with the learner's database.

#### Open questions

- There is no install prompt or "update available" message. Updates apply silently on the next navigation.
- The manifest description says the app "runs entirely in your browser", which is untrue for desktop and Android and ignores the LLM calls.

---

### Desktop host (Tauri)

**Purpose:** The same app in a native window, adding what the system webview (WebKitGTK) cannot do. **Status: a spike, not shipped.**

#### What it adds

- **Native persistence:** WebKitGTK has no OPFS, so the database is a SQLite file (see Storage and durability per host).
- **Native speech:** synthesis, low-latency playback, and on-device dictation, with the models downloaded on demand into the app data directory.
- **YouTube captions natively:** the webview's origin is one YouTube refuses, so the app fetches caption tracks itself.
- **Embedded YouTube player:** YouTube refuses to play inside the app's custom scheme, so the player runs in a separately hosted page that the app frames and controls. If the build has no embed page configured, a YouTube text says so where the video would be and stays readable.
- **The microphone permission** is granted by the app, because the webview has no prompt of its own.

#### Behaviour

- One window loading `/`. There is no native menu, tray, auto-update, file dialog or deep-link handling.
- Every screen draws its own back control, because there is no browser chrome.
- If the database fails to open, the same boot-error screen as the web build is shown, and the reason is printed to the terminal.

#### Open questions

- **A reload on a deep route is unsupported,** because there is no shell fallback on the custom scheme. Yet the app reloads in several places: after an import (from `/settings`), the sync "Reload now" button, and the stale-chunk heal.
- Not yet done: a CSP, devtools still enabled in release builds, no window-state persistence, no macOS or Windows builds, unsigned packages, and the voice download cannot be cancelled.
- Captions depend on an undocumented YouTube endpoint answering as its Android client. Should the product guarantee anything about them?
- Whether the desktop build should sync by default is undecided.

---

### Android host

**Purpose:** The desktop shell built as an APK for arm64 phones. A spike within the spike, built only in CI and installed on a phone once.

#### What it has

- Native persistence.
- Native synthesis, played through the webview's audio element.
- Native dictation, with microphone permissions declared. A device without a microphone can still install, and dictation becomes typing.
- YouTube caption fetching, made natively.
- Everything else in the web app.
- Release builds signed with a stable key, so each APK installs over the last and keeps its data.

#### What it lacks

- Host-side audio playback (not needed on Android).
- Service-worker offline caching. Registration fails harmlessly, because the app ships its own assets.

#### Open questions

- Dictation, its permission flow and decoding speed on a phone are all unverified.
- Only arm64 is built. No other screen sizes or Android versions have been tried.

---

### Nix package and Linux packaging

**Purpose:** A one-command desktop install on NixOS, and a portable Linux build for everyone else.

#### Behaviour

- `nix run .` builds and opens the desktop app with this deployment's sync relay and YouTube embed page built in. Both can be overridden or turned off when packaging. The package brings its own webview, media plugins and network modules, and installs a desktop entry and icon.
- An AppImage, built in CI on an old Ubuntu baseline, bundles the media plugins and needs the system WebKitGTK.

#### Guarantees

- The nix package and the AppImage run the same app as the web build. Only the host-specific features above differ.

---

### Layout and navigation

**Purpose:** Every screen works on a phone first and gets better, never worse, with width. Every screen has a way out that does not depend on browser chrome.

#### Behaviour

- **Mobile-first:** the phone layout is the base case. Exactly two wider breakpoints exist, at 48rem (two facing columns become possible) and at 72rem (full desktop).
- **Width buys** a second column, a wider gutter or denser grids. **It never makes a line of prose longer.** Reading text is capped at a fixed measure. Forms and chat bubbles stay bounded even in wide rows.
- Each page picks a width cap by what its content is: a single reading column, a roomier column, two facing pages, or a dense grid. Pairs of related content sit opposite each other. A long run of independent cards flows into two balanced columns in source order, which keeps the Danger zone last.
- **One exception:** in the reader's follow view, a video is allowed to take the full desktop width. The transcript beside it stays a bounded column, and the caption block under the video takes the video's width.
- **Main navigation:** Today, Practice, Explore and Garden, plus a More menu holding the language picker, Profile and Settings. On phones it is a fixed bottom bar. It is hidden on immersive screens (a practice session, an open text, a live conversation) and on screens outside the main map (onboarding, settings, profile, the voice test bench).
- **Back links:** every screen that is not a primary destination draws one back control, top left. Its target is that screen's fixed parent, never "history back", so it works after a deep link, a reload or in a fresh desktop window. Each view state within a page needs a way out, and an error state counts as one.
- **Boot:** a full-screen spinner until the database is open and the profile is known. With no profile, the learner is sent to onboarding.

#### Guarantees

- A wide-screen change must never alter the phone layout.
- A new page without a way back, or with a "history back", fails a check.

#### Open questions

- The layout rule says every route except `/` and `/onboarding` has a back link. In practice `/explore`, `/learn`, `/learn/session` and `/words` are also exempt: they are primary destinations, or have their own quit control. The rule's wording should match the exemptions.
- Settings, Profile and the test bench have no main navigation and only a back link, so Settings is reachable only through More. Is that intended?

---

## Appendix — where it lives today

A map from this spec to the current code, for orientation during a rewrite. Not part of the contract.

### Learning loop

- Routes: `src/routes/+page.svelte` (Home), `src/routes/onboarding/` (+ `steps.ts`), `src/routes/explore/check/` (word check, `check.ts`), `src/routes/learn/+page.svelte` (start screen), `src/routes/learn/session/+page.svelte` (stream), `src/routes/learn/*.svelte` (challenge components, `FeedbackBanner`, `ChallengeHost`, `blocks/`), `src/routes/words/`, `src/routes/profile/`, `src/routes/activity/` (+ `calendar.ts`).
- Frontend logic: `src/lib/session/` (`engine.ts`, `stream.ts`, `serving.ts`), `src/lib/challenges/` (seam, presentation registry, serve/check wrappers), `src/lib/srs/scheduler.ts`, `src/lib/words/view.ts`, `src/lib/llm/` (`mock.ts`, `getBatch`, `getEscalation`, `wordBatch`), `src/lib/tasks/kinds/top-up.ts`, `src/lib/ui/prefs.ts` (readings, listening, recent topics), `src/lib/db/day.ts` (local days, streak).
- Rust core: `crates/sapling-challenges` (`challenge.rs` union, `grade.rs`/`matcher.rs`, `help.rs`, `serve.rs`, `fits.rs`, `model.rs`, `stream.rs`, `topup.rs`, `pool.rs`, `match_pairs.rs`, `kinds.rs`, `replay.rs`, `calibrate.rs`; data in `data/kinds.json`, `data/model.json`), `crates/sapling-srs` (FSRS card machine, strength), `crates/sapling-llm` (`lesson.rs`, `wire.rs`, `escalation.rs`, `word_batch.rs`, `lessons/*.json`, `prompts/`), `crates/sapling-db` (`learned.rs` derived skills, `get_daily_activity`).
- Contracts: `.claude/rules/{session,challenges,llm,data}.md`, `docs/challenge-difficulty.md`, `docs/word-check.md`.

### Reading, media and conversation

- Routes:
  - `src/routes/explore/+page.svelte`
  - `src/routes/explore/check/{+page.svelte,check.ts}`
  - `src/routes/read/+page.svelte` (the library and its drawers), with `MediaCard.svelte`, `VideoImport.svelte`, `TextImport.svelte`, `FileSlot.svelte` and `compose.ts` beside it
  - `src/routes/read/[id]/+page.svelte` (reader and follow view)
  - `src/routes/chat/+page.svelte`
  - `src/routes/converse/+page.svelte`
  - `src/routes/converse/[id]/+page.svelte`
  - `src/routes/+page.svelte` (home entry points)
- Reading:
  - `src/lib/reading/` (`annotate.ts`, `tokenize.ts`, `pages.ts`, `index.ts`)
  - `crates/sapling-llm/src/reading.rs` and `prompts/reading-*.txt` (generate, look up, translate)
- Import: `crates/sapling-import/src/{lib,subtitles,paragraphs}.rs`
- Media:
  - `src/lib/media/` (`player.ts`, `video.ts`, `youtube.ts`, `youtube-framed.ts`, `youtube-host.ts`, `embed-protocol.ts`, `youtube-url.ts`, `youtube-error.ts`, `follow.ts`, `files.ts`, `captions.ts`)
  - `embed/` (the hosted YouTube page)
- Captions:
  - `crates/sapling-captions/src/lib.rs`
  - `src/lib/tasks/kinds/captions.ts`
  - `src/lib/tasks/kinds/read-generate.ts`
- Assistant:
  - `crates/sapling-llm/src/{tools,chat}.rs`
  - `prompts/{chat,tool-*}.txt`
  - `src/lib/assistant/`
- Conversation:
  - `crates/sapling-llm/src/conversation.rs`
  - `prompts/{scenario,teacher*}.txt`
  - `src/lib/conversation/{index,diff}.ts`
- Text rules: `src/lib/text/`, `crates/sapling-llm/src/text.rs` (card identity, loose romanization comparison)
- Romanization, speech and dictation: `src/lib/romanize/`, `src/lib/tts/`, `src/lib/asr/`, `src/lib/ui/SpeakButton.svelte`
- Design docs and contracts: `docs/reading-mode.md`, `docs/conversation-mode.md`, `.claude/rules/{reading,media,assistant,content}.md`

### Platform, data and hosts

- Event log, merge rules, derived state, export/import/reset, language profiles: `crates/sapling-db`, `crates/sapling-domain`, `crates/sapling-protocol`; UI-side access `src/lib/db/` (`repositories.ts`, `protocol.ts`, `sqlite.worker.ts`, `tauri.ts`, `settings.ts`); golden fixtures `src/lib/db/fixtures/`.
- Spaced-repetition card: `crates/sapling-srs`, `src/lib/srs/`.
- Sync client: `crates/sapling-sync`, `src/lib/sync/`. Relay: `worker/`, `wrangler.jsonc`. Docs: `docs/sync.md`.
- Native host: `crates/sapling-desktop` (Tauri glue, Android project in `gen/android`), `crates/sapling-store`, `crates/sapling-speech`, `crates/sapling-models`, `crates/sapling-captions`; `crates/sapling-wasm` for the browser build. Docs: `docs/desktop.md`.
- Background tasks: `src/lib/tasks/`, `src/lib/ui/TaskTray.svelte`, `src/lib/ui/TaskLedger.svelte`.
- Speech: `src/lib/tts/`, `static/tts/`; dictation `src/lib/asr/`, `static/asr/`.
- Pages: `src/routes/settings/`, `src/routes/tts-test/`, `src/routes/+layout.svelte`, `src/lib/ui/AppNav.svelte`, `src/lib/ui/BackLink.svelte`, `src/routes/back-link.test.ts`, `src/lib/ui/prefs.ts`, `src/lib/platform.ts`, `src/lib/device.ts`, `src/app.css`.
- Web host: `src/service-worker.ts`, `static/_headers`, `static/_redirects`, `static/404.html`, `static/manifest.webmanifest`, `src/lib/ui/preload-reload.ts`; embed page `embed/`; CI `.github/workflows/deploy.yml`; packaging `flake.nix`.
- Contracts: `.claude/rules/{data,core,deploy,desktop,tasks,layout,content}.md`.

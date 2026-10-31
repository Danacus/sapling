# textbook-ocr

Throwaway prototype: does a cheap vision model transcribe a scanned textbook
page into the JSON a textbook import would need? Not part of the Sapling app,
and nothing here is a contract. It runs on plain Node 22 with no dependencies.

- `prompt.txt`: the transcription prompt (`{{target}}` and `{{native}}` filled per page)
- `schema.json`: the reply, sent as a strict `json_schema` (plain JSON mode for a model that refuses it)
- `truth/*.json`: the hand-written reply each test page should get
- `pages/`: the page images, gitignored (scans of copyrighted books stay out of the repo)
- `out/`: the replies, one file per model per page, gitignored

## Pages

Each `truth/<name>.json` names its image, which goes in `pages/`:

| truth | image | book |
|---|---|---|
| `hsk1-p14` | `hsk1-p14.png` | HSK Standard Course 1, lesson 3 opening: dialogue, New Words, Proper Noun |
| `hsk1-p24` | `hsk1-p24.png` | HSK 1 grammar notes with inline glosses, and exercise questions with pinyin |
| `nl-p14-15` | `nl-p14-15.png` | Dutch course, Les 2: four dialogues, phrase boxes, a meaning-less word list |
| `nl-p16-17` | `nl-p16-17.png` | Dutch, Les 3A/3B: picture captions only |
| `nl-p19-20` | `nl-p19-20.png` | Dutch, Les 3 word list and the Les 4 opening: numbered monologues |

To add a page, put the image in `pages/` and write its truth by hand. Leave out
of the truth anything the prompt says to leave out.

## Run

Node's built-in `fetch` ignores `HTTPS_PROXY`. Behind a proxy (a Claude Code
cloud session, for one), prefix each command with `NODE_USE_ENV_PROXY=1`.

```sh
node tools/textbook-ocr/run.mjs --list [--max 0.02]  # vision models under $0.01 (or --max) a page, cheapest first
OPENROUTER_API_KEY=... node tools/textbook-ocr/run.mjs [--models a,b] [--pages hsk1-p14,nl-p14-15] [--repeat N [--from K]] [--reasoning off|low|medium|high|default]
node tools/textbook-ocr/score.mjs [--verbose]  # --verbose lists every missing and extra line
```

Replies vary from run to run, so `--repeat N` writes N more rounds beside the
existing replies (`page.r1.json`, …; `--from K` numbers them after K) and the
scorer averages all of them. Reasoning is off by default: copying a page needs
none, and reasoning models left to it spent the whole token budget thinking. A
model that requires it is retried at `low`. A reply that fails to parse is
retried once, as an import would, and both calls count toward time and cost.

## What the scores mean

Text is compared after NFKC, collapsed whitespace, no spaces inside CJK and none
before `!?.,;:`. Everything else counts, so a wrong character is a miss.

Both sides are cut into sentences first, so a model that keeps a monologue as
one line scores like one that keeps the book's line breaks. The scorer also does
the clean-up an importer would: it strips a dialogue number or colon from a
speaker label ("1. Paolo", "A:"), strips the speaker label from the start of a
translation, and unwraps a reply that comes back inside an array.

- `lineRecall`: share of expected sentences found verbatim, ignoring closing punctuation
- `cer`: character error rate over all lines joined in reading order. A different order also counts against it.
- `speaker`: of the lines found, how many have the right speaker, after a `null` speaker inherits the previous one
- `reading`, `translation`: of the lines found that print one, how many match
- `wordRecall`: share of expected vocabulary terms found (bare headword, no article)
- `grammar`, `meaning`: of the words found, how many have the right article or forms, and meaning
- `$/page`: OpenRouter's reported cost. With your own provider key (BYOK), this is what the provider charged. `s/page`: wall time.
- A failed call counts as an empty reply.

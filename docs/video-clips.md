# Video clips in practice — design

Status: step 1 (§5) and the cue-cloze (§6) are built; steps 2–3 are the plan.

Practice speaks every sentence with TTS. A learner who has imported YouTube
videos already holds real speech for many of their words: every subtitle cue
is a timed span of a recording (`Segment.start`/`end`, ms) and the text knows
which recording (`ReadingMedia`). This feature plays those spans inside
practice — first beside the feedback, then as the prompt itself.

## 1. The constraint

The areas stay apart. A challenge row never reads the `texts` table at serve
time, a challenge component never learns what plays a sound, and `$lib/media`
stays stateless. Everything below goes through seams that already exist:
`Served.audio` (what a challenge sounds like), `Player` (how a recording
plays), `BatchArgs` (what a lesson is written from) and the `Backend` table.

## 2. One sound type

`Served.audio` becomes a list of `Sound`, not strings:

```rust
enum Sound {
    Speak { text: String },
    Clip  { media: ReadingMedia, start: f64, end: f64, text: String },
}
```

The frontend plays both through one `play(sound)`. A `Clip` goes through the
`Player` seam (`youtubePlayerForHost`, so desktop takes the framed player) and
pauses at `end`. **Any failure or timeout speaks `text` instead** — sound
never blocks play, and a clip is always also a sentence. A `ClipStage` block
in `challenges/blocks/` shows the video where it is visible; it is the only
challenge-side importer of `$lib/media`.

## 3. A clip on the row

A plugin whose prompt *is* the target sentence (multiple-choice and typed
translation to-native, possibly cloze) gains an optional stored `clip:
{media, start, end}` — additive, lenient, as every stored field. It is a
**copy**, never a `textId`: serving needs no join, deleting the text breaks
nothing, and it syncs as a few bytes. The plugin's `audio_texts` answers
`Sound::Clip` when it is set. `Common`, `fits`, the stream and the planner
never see it.

## 4. Generation from real sentences

The planner decides wants exactly as now. The host reads timed YouTube cues
containing each wanted word (a `Backend` read) and passes them in `BatchArgs`
as `sources`; the LLM layer stays stateless. The prompt says: when a source
fits, use it verbatim as the sentence and cite it. The resolver checks the
quote is verbatim and attaches the clip from the *data*, never from the
model — the model emits content, and the span is not content.

Generation still introduces no word: the target word is the subject, and the
cue's other words are the same comprehension load any sentence carries.

Difficulty needs nothing new: a clip row is served at `listening`, and its own
learned correction absorbs that real speech is harder than TTS. A separate
`clip` modifier on `HelpLevel` is added only if `calibrate` shows clip rows
sit consistently off their kind.

## 5. Steps

1. **Heard in a video** (built; no stored change). The feedback banner offers
   the answered word spoken in a video. `clipsFor(terms, sentence?)` (a
   `Backend` read) answers the best tier of timed YouTube cues holding one of
   the challenge's words, at most five, best first: a cue that is the served
   sentence ranks first, then more of the words, then closeness to the
   sentence and a comfortable length (3–14 words, 1–8 s), so a one-word
   fragment loses to a sentence. A word is whole by its spaces, or — in a
   script without them — when no longer word the learner knows covers it (行
   is not in 银行 once 银行 is theirs). The ranking is deterministic and the
   page picks among the tier at random, so the same word is heard in
   different places. `ClipStage` (`challenges/blocks/`) mounts the player when
   the banner shows and, on Play, plays the padded span and pauses at its end
   (`media/span.ts`). A failed player leaves the banner as it was. It settles
   playback — load time, ads, framing, whether it is worth hearing — before
   anything permanent is written.
2. **Cues as sources** (no stored change). `sources` in `BatchArgs` and the
   prompt line of §4; the banner's read already prefers a cue whose
   normalised text equals the challenge's sentence (step 1), so a lesson
   written from a cue plays that exact sentence. Measures how often the model takes a cue verbatim.
3. **Stored clips and listening.** `Sound` (§2), `clip` on the row (§3) and
   the resolver attaching it (§4). A clip row's listening level plays the
   recording as the prompt; step 2's text match is retired.

## 6. A cue-cloze

A `cue-cloze` (`crates/sapling-challenges/src/types/cue_cloze/`) is one of the
learner's own timed cues with one of their words blanked — the first **local**
kind: built on the device from the learner's material, never by the model.
Its kind is `local` in `type.json`, so it has no lesson file, is never sent to
`getBatch`, and is left out of what `fits.rs` counts as writable (the window
widens only to rows a writer can always produce; a cue may not exist).

- **What it is cut from.** `cuesFor(itemIds)` (a `Backend` read) answers, per
  word, the timed cues of any imported text — YouTube, a file, or none —
  holding the term as a whole word under `clipsFor`'s rule (§5), at most
  thirty, newest text first. A cue's text is copied onto the row with
  `cue: {textId, videoId?, start, end}`, `videoId` for YouTube media only.
- **When.** `generateChallenges` asks for the cues of the words the plan wants
  for and passes the words with one to `planTopUp` as `cued`; only those words
  can be planned a local kind, and the planner's usual rotation (a kind the
  word never had first, a draw among the rest) mixes it with the model's kinds
  with no preference either way.
- **How.** `writeLocal` (the wasm `challenges` export, `local.rs`) builds each
  local want: for every candidate cue not already in the pool for that word,
  it blanks the first whole-word occurrence (the answer is the term as the cue
  spells it), keeps rows whose measured length is in the kind's band (3–14
  words) and that pass `fits_fresh`, and takes the one nearest the asked
  length, a draw breaking a tie. The row's `length` is its measured length.
  The bank is the answer plus five random other words of the learner's — none
  the answer itself, none already in the cue — with no similarity criterion. A
  helper model call that picks distractors is a possible later step. A local
  want with nothing that fits becomes a model-written want for the same word
  (the same rotation over the kinds the model writes, less those already
  wanted); the rest of the wants go to `getBatch` unchanged.
- **Serving.** Steps pick-4, pick-6, typed, as a cloze. A cue has no
  translation, so the easiest step shows the word's meaning (`meaningHint`).
  Readings are romanized at render time, so `has_readings` is whether the cue
  is written in a script other than Latin. Audio is TTS for now.
- **Grading.** Only the learner's own term is graded, matched as a whole word
  when the row was built. A caption's mis-hearings and missing punctuation
  elsewhere in the line are context noise, not grading errors.
- **Heard in.** The served sentence completes to the cue's text, so
  `clipsFor` ranks that very cue first.

## 7. Limits

- **YouTube only for playing.** A file's `File` handle comes only from a
  picker the learner clicked, once per tab, which practice cannot ask for. A
  desktop file path could lift this later. A cue-cloze is cut from file media
  too; only "Heard in" needs the recording.
- **Load time and pre-roll ads** can swallow a three-second span. The player
  is mounted when the banner shows, the span is padded by 250 ms each side,
  and a span that does not start in time falls back to TTS.
- **Cues are fragments, and automatic captions mis-hear and carry no
  punctuation.** A cue-cloze accepts that as context: it never grades the
  caption, only the blanked term, which is one of the learner's words found in
  it as a whole word.
- **Offline**, a clip falls back to its text spoken, so the listening level
  stays available and `Serving.audio` keeps its meaning.

## 8. Left out

"Type what you hear" graded against a whole cue: the grading would trust
automatic captions, and §3–4 give the same listening practice through the
existing plugins.

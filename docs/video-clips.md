# Video clips in practice — design

Status: step 1 (§5) is built; steps 2–3 are the plan.

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

## 6. Limits

- **YouTube only.** A file's `File` handle comes only from a picker the
  learner clicked, once per tab, which practice cannot ask for. A desktop
  file path could lift this later.
- **Load time and pre-roll ads** can swallow a three-second span. The player
  is mounted when the banner shows, the span is padded by 250 ms each side,
  and a span that does not start in time falls back to TTS.
- **Cues are fragments, and automatic captions mis-hear and carry no
  punctuation.** Fine as a sound; risky as a sentence that is graded. That is
  why the model picks and cites a cue (§4) rather than a challenge being built
  from one locally.
- **Offline**, a clip falls back to its text spoken, so the listening level
  stays available and `Serving.audio` keeps its meaning.

## 7. Left out

A locally built "type what you hear" challenge graded against a cue: the
grading would trust automatic captions, and §3–4 give the same listening
practice through the existing plugins.

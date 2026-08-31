#!/usr/bin/env python3
"""Transcribe a video's audio to .srt with faster-whisper (CTranslate2, CPU int8).

faster-whisper decodes media through PyAV, so the video goes in directly — no
manual audio extraction. Segments stream lazily, so progress is printed as the
decoder reaches each one.
"""

import argparse
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel


def ts(seconds: float) -> str:
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def regroup(words, max_dur: float, min_words: int = 2):
    """Split word-level timestamps into cues of roughly ≤max_dur seconds.

    Avoids orphan tails: if the last cue would have fewer than min_words,
    it gets absorbed into the previous one.
    """
    if not words:
        return []

    cues = []
    cur = [words[0]]

    for w in words[1:]:
        if w.end - cur[0].start > max_dur and len(cur) >= min_words:
            cues.append(cur)
            cur = [w]
        else:
            cur.append(w)

    if cur:
        if len(cur) < min_words and cues:
            cues[-1].extend(cur)
        else:
            cues.append(cur)

    return cues


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("video", type=Path)
    p.add_argument("-o", "--output", type=Path, help="default: input with .srt suffix")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--lang", default="zh", help="language code, or 'auto' to detect")
    p.add_argument("--cpu-threads", type=int, default=0, help="0 = auto")
    p.add_argument("--vad", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument(
        "--max-duration",
        type=float,
        default=None,
        metavar="SECS",
        help="split cues so none exceeds this duration (enables word timestamps)",
    )
    p.add_argument(
        "--initial-prompt",
        default="以下是普通话的句子。",
        help="biases the decoder; the default asks for simplified script",
    )
    args = p.parse_args()

    out = args.output or args.video.with_suffix(".srt")
    started = time.monotonic()

    print(f"loading {args.model} (cpu, int8)…", file=sys.stderr, flush=True)
    model = WhisperModel(
        args.model, device="cpu", compute_type="int8", cpu_threads=args.cpu_threads
    )

    segments, info = model.transcribe(
        str(args.video),
        language=None if args.lang == "auto" else args.lang,
        vad_filter=args.vad,
        initial_prompt=args.initial_prompt or None,
        beam_size=5,
        word_timestamps=args.max_duration is not None,
    )
    total = info.duration
    print(
        f"language={info.language} ({info.language_probability:.2f}) "
        f"duration={ts(total)}",
        file=sys.stderr,
        flush=True,
    )

    n = 0
    with out.open("w", encoding="utf-8") as f:
        for seg in segments:
            if args.max_duration is not None:
                words = seg.words or []
                for cue in regroup(words, args.max_duration):
                    text = "".join(w.word for w in cue).strip()
                    if not text:
                        continue
                    n += 1
                    start, end = cue[0].start, cue[-1].end
                    f.write(f"{n}\n{ts(start)} --> {ts(end)}\n{text}\n\n")
                    f.flush()
                    elapsed = time.monotonic() - started
                    print(
                        f"[{ts(end)}/{ts(total)}] {elapsed / 60:.1f}min elapsed "
                        f"| {n:4d} | {text[:60]}",
                        file=sys.stderr,
                        flush=True,
                    )
            else:
                text = seg.text.strip()
                if not text:
                    continue
                n += 1
                f.write(f"{n}\n{ts(seg.start)} --> {ts(seg.end)}\n{text}\n\n")
                f.flush()
                elapsed = time.monotonic() - started
                print(
                    f"[{ts(seg.end)}/{ts(total)}] {elapsed / 60:.1f}min elapsed "
                    f"| {n:4d} | {text[:60]}",
                    file=sys.stderr,
                    flush=True,
                )

    elapsed = time.monotonic() - started
    print(
        f"wrote {out} — {n} cues, {elapsed / 60:.1f}min wall for "
        f"{total / 60:.1f}min audio (RTF {elapsed / total:.2f}x)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

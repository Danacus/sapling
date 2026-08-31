# whisper-srt

Throwaway prototype: transcribe a video's speech to `.srt` with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2), CPU int8.
Not part of the Sapling app. Check for a real subtitle stream first —
`ffprobe -v error -select_streams s -show_entries stream=index,codec_name -of csv file.mkv`.

**Setup:** `nix-shell -p python312 stdenv.cc.cc.lib zlib --run ./setup.sh`

**Usage:** `./run.sh video.mkv --model large-v3-turbo --lang zh` — always via `run.sh`,
which puts the store's gcc-lib + zlib on `LD_LIBRARY_PATH` (the pip wheels aren't
patchelf'd: PyAV wants `libz.so.1`, CTranslate2 `libstdc++`/`libgomp`). Writes
`video.srt` beside the input; PyAV reads the container, so no audio extraction.
`--no-vad`, `--initial-prompt` (default `以下是普通话的句子。`, biasing simplified), `--lang auto`.

**Models:** `large-v3-turbo` (~1.6 GB) is the default sweet spot — near large-v3
quality at ~4x speed (4 decoder layers, not 32). `small`/`medium` on a slow box.

## Status

Verified on NixOS 2026-08-30 (faster-whisper 1.2.1, ctranslate2 4.8.1, PyAV 18.1.0,
py3.12), 14:56 Mandarin YouTube rip, 16 threads, `large-v3-turbo` int8: **4.3 min
wall, RTF 0.29x** including the one-off model download (~0.19x steady-state), 24
cues, `language=zh` p=1.00, simplified throughout. VAD merges aggressively — cues
run 20-45 s, fine for a transcript but too coarse to display as subtitles; splitting
would need `word_timestamps=True`.

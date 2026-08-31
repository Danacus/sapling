# hardsub-ocr

Throwaway prototype: OCR burned-in (hardcoded) subtitles out of a video into an
`.srt`, via [videocr-PaddleOCR](https://github.com/devmaxxing/videocr-PaddleOCR).
Not part of the Sapling app — a scratch tool for producing subtitle files.

**Check for a real subtitle stream first** — OCR is slow and lossy, and most
sources already carry text: `ffprobe -v error -select_streams s -show_entries stream=index,codec_name:stream_tags=language -of csv file.mp4`,
or `yt-dlp --list-subs URL`. Only OCR when that comes back empty.

## Setup

```sh
nix-shell -p python312 stdenv.cc.cc.lib zlib libGL glib --run ./setup.sh
```

Python must be < 3.13, and the package is **not on PyPI** — setup.sh installs it
from git.

## Usage

Always go through `run.sh`; it sets the `LD_LIBRARY_PATH` the pip wheels need.

```sh
./run.sh /path/to/video.mp4 --lang ch --band 0.25
```

Writes `video.srt` next to the input. `--band` is the bottom fraction of the
frame to scan (default 0.22); `--crop-y`/`--crop-height` override it in pixels.
First run downloads PaddleOCR models. `--lang`: `ch`, `en`, `japan`, `korean`, …
`--onednn` re-enables the oneDNN kernels (see Status) if a future paddlepaddle
fixes them.

## AV1 input

OpenCV's bundled FFmpeg can't decode some AV1 streams (endless
`Missing Sequence Header` + an empty srt). AV1 is what yt-dlp usually picks for
high-res YouTube. Transcode to H.264 first (audio isn't needed):

```sh
ffmpeg -i in.mp4 -map 0:v:0 -c:v libx264 -crf 20 -preset veryfast -an in_h264.mp4
```

or avoid it at download time: `yt-dlp -S vcodec:h264 URL`.

## Status

End-to-end OCR verified on NixOS 2026-08-30 (paddlepaddle 3.3.1, paddleocr
3.7.0, videocr 0.1.7) — a synthetic 1280x720 clip came back as an exact `.srt`.

`.venv/bin/python` alone fails with `libstdc++.so.6: cannot open shared object
file` and then `libgthread-2.0.so.0` — the pip wheels aren't patchelf'd.
`run.sh` resolves gcc-lib, zlib, libglvnd and glib from the store into
`LD_LIBRARY_PATH`, which fixes both.

**oneDNN on CPU.** paddlepaddle 3.x's PIR executor can't lower a oneDNN op
whose attribute is an array of doubles, so the first detection frame died with
`NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute not
support [pir::ArrayAttribute<pir::DoubleAttribute>]`. `extract_subs.py` now
wraps the `PaddleOCR` class videocr imported and passes `enable_mkldnn=False`,
which is the only lever that reaches the inference `Config` — the `FLAGS_*` env
vars (`FLAGS_enable_pir_api`, `FLAGS_use_mkldnn`, `FLAGS_enable_pir_in_executor`)
were all tried and change nothing. Plain CPU kernels are slower but correct;
`--onednn` opts back in, and `--use-gpu` skips the workaround entirely.

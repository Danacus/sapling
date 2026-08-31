#!/usr/bin/env python3
"""Extract burned-in subtitles from a video into an .srt, via videocr-PaddleOCR."""

import argparse
import subprocess
import sys
from pathlib import Path


def probe_size(video: Path) -> tuple[int, int]:
    """Frame (width, height) in pixels, via ffprobe (falls back to cv2)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video)],
            capture_output=True, text=True, check=True,
        ).stdout.strip().splitlines()[0]
        w, h = (int(n) for n in out.split(",")[:2])
    except Exception:
        import cv2  # noqa: PLC0415
        cap = cv2.VideoCapture(str(video))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cap.release()
    if not w or not h:
        sys.exit(f"could not determine frame size of {video}")
    return w, h


def disable_onednn() -> None:
    """Force PaddleOCR onto the plain CPU kernels.

    paddlepaddle 3.x's PIR executor cannot lower a oneDNN op whose attribute is
    an array of doubles, so the very first detection frame dies with
    `ConvertPirAttribute2RuntimeAttribute not support
    [pir::ArrayAttribute<pir::DoubleAttribute>]`. Only PaddleOCR's own
    `enable_mkldnn=False` reaches the inference Config that picks the kernels --
    the FLAGS_* env vars do not -- and videocr constructs PaddleOCR itself, so
    wrap the class it imported.
    """
    from videocr import video as videocr_video  # noqa: PLC0415

    inner = videocr_video.PaddleOCR

    def patched(*args, **kwargs):
        try:
            return inner(*args, enable_mkldnn=False, **kwargs)
        except (TypeError, ValueError):
            return inner(*args, **kwargs)  # PaddleOCR < 3 has no such argument

    videocr_video.PaddleOCR = patched


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("video", type=Path)
    p.add_argument("-o", "--output", type=Path, help="default: <video>.srt")
    p.add_argument("--lang", default="ch", help="PaddleOCR lang code (default: ch)")
    p.add_argument("--band", type=float, default=0.22,
                   help="OCR the bottom N fraction of the frame (default: 0.22)")
    p.add_argument("--crop-y", type=int, help="explicit crop top, in px (overrides --band)")
    p.add_argument("--crop-height", type=int, help="explicit crop height, in px")
    p.add_argument("--sim-threshold", type=int, default=80)
    p.add_argument("--conf-threshold", type=int, default=75)
    p.add_argument("--frames-to-skip", type=int, default=1)
    p.add_argument("--time-start", default="0:00")
    p.add_argument("--time-end", default="")
    p.add_argument("--use-gpu", action="store_true")
    p.add_argument("--onednn", action="store_true",
                   help="re-enable oneDNN/mkldnn kernels (faster, but crashes on paddlepaddle 3.x CPU)")
    a = p.parse_args()

    if not a.video.is_file():
        sys.exit(f"no such file: {a.video}")

    w, h = probe_size(a.video)
    if a.crop_y is not None and a.crop_height is not None:
        crop_y, crop_h = a.crop_y, a.crop_height
    else:
        crop_h = a.crop_height or max(1, round(h * a.band))
        crop_y = a.crop_y if a.crop_y is not None else h - crop_h

    out = a.output or a.video.with_suffix(".srt")
    print(f"OCR {a.video} lang={a.lang} crop_y={crop_y} crop_height={crop_h}", flush=True)

    from videocr import save_subtitles_to_file  # slow import; after arg parsing

    if not (a.use_gpu or a.onednn):
        disable_onednn()

    save_subtitles_to_file(
        str(a.video),
        str(out),
        lang=a.lang,
        use_gpu=a.use_gpu,
        time_start=a.time_start,
        time_end=a.time_end,
        conf_threshold=a.conf_threshold,
        sim_threshold=a.sim_threshold,
        frames_to_skip=a.frames_to_skip,
        # all four or videocr warns "incomplete crop provided" and ignores them
        crop_x=0,
        crop_width=w,
        crop_y=crop_y,
        crop_height=crop_h,
    )
    print(f"wrote {out.resolve()}")


if __name__ == "__main__":
    main()

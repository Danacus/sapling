#!/usr/bin/env bash
# Create .venv here and install videocr-PaddleOCR (the maintained PaddleOCR fork
# of videocr). It is NOT on PyPI under that name — install straight from git.
# It requires Python < 3.13, so pin python312; nix's plain `python3` is 3.13.
#
# NixOS: run under a nix-shell that supplies the native libs paddle/opencv
# link against:
#
#   nix-shell -p python312 stdenv.cc.cc.lib zlib libGL glib --run ./setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

PY=${PY:-python3}
"$PY" -m venv .venv
./.venv/bin/pip install --upgrade pip wheel
./.venv/bin/pip install "videocr @ git+https://github.com/devmaxxing/videocr-PaddleOCR.git"
./.venv/bin/python -c "import paddle" 2>/dev/null || ./.venv/bin/pip install paddlepaddle

echo "--- smoke test (via run.sh, which sets LD_LIBRARY_PATH) ---"
./run.sh --help >/dev/null && echo "import ok"

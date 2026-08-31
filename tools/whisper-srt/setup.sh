#!/usr/bin/env bash
# Create .venv here and install faster-whisper (CTranslate2 + PyAV, both wheels).
# Pin python312: ctranslate2's manylinux wheels lag a release behind on 3.13,
# and 3.12 is the version the hardsub-ocr sibling already proved out here.
#
# NixOS: run under a nix-shell that supplies the native libs the wheels link
# against (libstdc++ and libgomp from gcc's lib output, libz for PyAV):
#
#   nix-shell -p python312 stdenv.cc.cc.lib zlib --run ./setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

PY=${PY:-python3}
"$PY" -m venv .venv
./.venv/bin/pip install --upgrade pip wheel
./.venv/bin/pip install faster-whisper

echo "--- smoke test (via run.sh, which sets LD_LIBRARY_PATH) ---"
./run.sh --help >/dev/null && echo "import ok"

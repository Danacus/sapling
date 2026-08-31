#!/usr/bin/env bash
# Run transcribe.py inside the .venv with the native libs CTranslate2 needs.
# On NixOS the pip wheels are not patchelf'd, so LD_LIBRARY_PATH has to point at
# gcc-lib — which carries both libstdc++.so.6 and libgomp.so.1 (OpenMP, which
# the CTranslate2 wheel is built against) — and at zlib, for PyAV's libz.
#
#   ./run.sh video.mkv --model large-v3-turbo --lang zh
#
set -euo pipefail
cd "$(dirname "$0")"

# nix-shell parses flags like --help itself, so smuggle the args through the env.
WHISPER_ARGS=$(printf '%q ' "$@")
export WHISPER_ARGS

exec nix-shell -p python312 stdenv.cc.cc.lib zlib --run '
  LDP=$(nix-build --no-out-link "<nixpkgs>" \
    -A stdenv.cc.cc.lib -A zlib 2>/dev/null \
    | sed "s|$|/lib|" | paste -sd:)
  export LD_LIBRARY_PATH="$LDP${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  eval "set -- $WHISPER_ARGS"
  exec ./.venv/bin/python transcribe.py "$@"
'

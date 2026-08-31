#!/usr/bin/env bash
# Run extract_subs.py inside the .venv with the native libs paddle/opencv need.
# On NixOS the pip wheels are not patchelf'd, so LD_LIBRARY_PATH has to point at
# gcc-lib (libstdc++), zlib, libglvnd (libGL) and glib (libgthread).
#
#   ./run.sh video.mp4 --lang ch --band 0.25
#
set -euo pipefail
cd "$(dirname "$0")"

# nix-shell parses flags like --help itself, so smuggle the args through the env.
HARDSUB_ARGS=$(printf '%q ' "$@")
export HARDSUB_ARGS

exec nix-shell -p python312 stdenv.cc.cc.lib zlib libGL glib --run '
  LDP=$(nix-build --no-out-link "<nixpkgs>" \
    -A stdenv.cc.cc.lib -A zlib -A libglvnd -A glib.out 2>/dev/null \
    | sed "s|$|/lib|" | paste -sd:)
  export LD_LIBRARY_PATH="$LDP${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  eval "set -- $HARDSUB_ARGS"
  exec ./.venv/bin/python extract_subs.py "$@"
'

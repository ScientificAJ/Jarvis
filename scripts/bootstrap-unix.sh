#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
RUNTIME="$ROOT/.runtime"
VENV="$RUNTIME/venv-$OS_NAME-$ARCH_NAME"
PYTHON="$VENV/bin/python"
MARKER="$RUNTIME/installed-streaming-$OS_NAME-$ARCH_NAME-v1.txt"
MODEL="$RUNTIME/streaming-model"

fail() {
  echo "Jarvis setup could not complete. Check the message above, your connection and free disk space." >&2
  echo "You can run bash Jarvis.sh again to retry." >&2
}
trap fail ERR

case "$OS_NAME" in
  Darwin|Linux) ;;
  *) echo "This launcher supports macOS and Linux. Use Jarvis.cmd on Windows." >&2; exit 1 ;;
esac
if [[ -f "$MARKER" && -x "$PYTHON" && \
      -f "$MODEL/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx" && \
      -f "$MODEL/decoder-epoch-99-avg-1-chunk-16-left-128.onnx" && \
      -f "$MODEL/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx" && -f "$MODEL/tokens.txt" ]]; then
  exit 0
fi

mkdir -p "$RUNTIME"
if [[ ! -x "$PYTHON" ]]; then
  BASE_PYTHON=""
  for candidate in python3.11 python3.12 python3.13 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import struct,sys; sys.exit(0 if (3,11) <= sys.version_info[:2] <= (3,13) and struct.calcsize("P") == 8 else 1)'; then
      BASE_PYTHON="$candidate"
      break
    fi
  done
  if [[ -z "$BASE_PYTHON" ]]; then
    echo "Install 64-bit Python 3.11, 3.12, or 3.13 and its venv support, then run this launcher again." >&2
    exit 1
  fi
  echo "Creating a private Python environment with $BASE_PYTHON..."
  "$BASE_PYTHON" -m venv "$VENV"
fi

echo "Installing the lightweight speech runtime..."
"$PYTHON" -m pip install --disable-pip-version-check --only-binary=:all: \
  'sherpa-onnx==1.13.8' 'numpy>=1.26.4,<3'
echo "Preparing the lightweight streaming speech model..."
"$PYTHON" "$ROOT/scripts/prepare_model.py"
printf '%s\n' 'Streaming speech runtime and model prepared.' > "$MARKER"
echo "Local speech model is ready."

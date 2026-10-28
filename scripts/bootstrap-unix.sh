#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
RUNTIME="$ROOT/.runtime"
VENV="$RUNTIME/venv-$OS_NAME-$ARCH_NAME"
PYTHON="$VENV/bin/python"
MARKER="$RUNTIME/installed-$OS_NAME-$ARCH_NAME-v1.txt"
export HF_HOME="$RUNTIME/huggingface"
export HF_HUB_DISABLE_XET=1
export HF_HUB_DISABLE_SYMLINKS_WARNING=1

fail() {
  echo "Jarvis setup could not complete. Check the message above, your connection and free disk space." >&2
  echo "You can run bash Jarvis.sh again to retry." >&2
}
trap fail ERR

case "$OS_NAME" in
  Darwin|Linux) ;;
  *) echo "This launcher supports macOS and Linux. Use Jarvis.cmd on Windows." >&2; exit 1 ;;
esac
if [[ "$OS_NAME" == "Darwin" && "$ARCH_NAME" != "arm64" ]]; then
  echo "The official PyTorch runtime required by Bark 3.0 provides macOS wheels for Apple silicon, not Intel Macs." >&2
  echo "On an Apple-silicon Mac, run a native arm64 terminal and install native arm64 Python." >&2
  exit 1
fi

if [[ -f "$MARKER" && -x "$PYTHON" && -f "$RUNTIME/bark-model/model.bark" && -f "$RUNTIME/bark-model/bark_loader.py" ]]; then
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

echo "Installing the local Bark 3.0 runtime. The first run can take a while..."
"$PYTHON" -m pip install --disable-pip-version-check --upgrade pip
if [[ "$OS_NAME" == "Linux" ]]; then
  TORCH_INDEX="https://download.pytorch.org/whl/cpu"
  if [[ "$ARCH_NAME" == "x86_64" && "${JARVIS_DEVICE:-auto}" != "cpu" ]] && command -v nvidia-smi >/dev/null 2>&1; then
    TORCH_INDEX="https://download.pytorch.org/whl/cu128"
    echo "NVIDIA graphics detected; installing the CUDA-enabled runtime."
  else
    echo "Installing the CPU runtime."
  fi
  "$PYTHON" -m pip install --disable-pip-version-check 'torch==2.8.0' --index-url "$TORCH_INDEX"
else
  # The macOS PyPI wheel includes MPS support on compatible Apple hardware.
  "$PYTHON" -m pip install --disable-pip-version-check 'torch==2.8.0'
fi
DEPENDENCIES=(
  'huggingface_hub==2.2.0' 'numpy==2.4.6' 'soundfile==0.14.0'
  'soxr==1.1.0' 'transformers==5.19.0' 'librosa==0.11.0'
)
if [[ "$OS_NAME" == "Linux" && "$ARCH_NAME" == "aarch64" ]]; then
  # The publisher does not ship a Linux ARM wheel for constriction 0.5.0.
  # Build that same tagged decoder from its official source when Rust is present.
  if ! command -v cargo >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
    echo "Linux ARM needs Git and a current Rust toolchain to build the Bark decoder." >&2
    exit 1
  fi
  echo "Building the official Bark decoder for Linux ARM; this may take a while..."
  "$PYTHON" -m pip install --disable-pip-version-check 'numpy==2.4.6' 'maturin>=1.7.1,<2.0'
  DECODER_SOURCE="$RUNTIME/constriction-v0.5.0"
  if [[ ! -d "$DECODER_SOURCE/.git" ]]; then
    git clone --branch v0.5.0 --depth 1 https://github.com/bamler-lab/constriction.git "$DECODER_SOURCE"
  fi
  VIRTUAL_ENV="$VENV" PATH="$VENV/bin:$PATH" "$VENV/bin/maturin" develop \
    --manifest-path "$DECODER_SOURCE/Cargo.toml" --features pybindings --release
else
  DEPENDENCIES+=('constriction==0.5.0')
fi
"$PYTHON" -m pip install --disable-pip-version-check "${DEPENDENCIES[@]}"
echo "Downloading Underdog Bark 3.0 and its speech processor..."
"$PYTHON" "$ROOT/scripts/prepare_model.py"
printf '%s\n' 'Bark 3.0 dependencies and model prepared.' > "$MARKER"
echo "Local speech model is ready."

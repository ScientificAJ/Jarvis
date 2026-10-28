#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd -P)"
echo
echo " J A R V I S"
echo " Preparing your local assistant..."
echo
bash "$ROOT/scripts/bootstrap-unix.sh"
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
exec "$ROOT/.runtime/venv-$OS_NAME-$ARCH_NAME/bin/python" "$ROOT/jarvis_server.py"

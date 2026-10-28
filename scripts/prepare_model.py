"""Download the pinned lightweight streaming model and verify its files."""
from __future__ import annotations

import hashlib
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / ".runtime" / "streaming-model"
MODEL_REVISION = "672fbf1b30579d6585301139bb363f42a0ad4a24"
BASE_URL = ("https://huggingface.co/csukuangfj/"
            "sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/" + MODEL_REVISION + "/")
FILES = {
    "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx": (71083163, "563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1"),
    "decoder-epoch-99-avg-1-chunk-16-left-128.onnx": (2092621, "7bf787f90b194b307e5a4ad6a34fadb4e748304c35f78a8d66358a05b13ee6ef"),
    "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx": (259335, "d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297"),
    "tokens.txt": (5048, "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb"),
}


def valid_file(path: Path, size: int, expected_hash: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as src:
        for block in iter(lambda: src.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest() == expected_hash


def prepare() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for name, (size, checksum) in FILES.items():
        destination = MODEL_DIR / name
        if valid_file(destination, size, checksum):
            continue
        temporary = destination.with_name(name + ".part")
        for attempt in range(3):
            try:
                print(f"Downloading {name}...", flush=True)
                request = urllib.request.Request(BASE_URL + name, headers={"User-Agent": "Jarvis/1.0"})
                digest = hashlib.sha256()
                received = 0
                with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        received += len(block)
                        if received > size:
                            raise ValueError("Downloaded model file exceeded its expected size.")
                        digest.update(block)
                        output.write(block)
                if received != size or digest.hexdigest() != checksum:
                    raise ValueError("Downloaded model file did not pass its checksum.")
                temporary.replace(destination)
                break
            except (OSError, ValueError, urllib.error.URLError):
                temporary.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                print("Download interrupted; retrying...", flush=True)
                time.sleep(attempt + 1)
    print("Lightweight streaming speech model is ready.", flush=True)


if __name__ == "__main__":
    prepare()

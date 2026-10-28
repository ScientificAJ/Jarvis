"""Inspect Bark's architecture without allocating its full weights."""
import json
from pathlib import Path
import torch
from transformers import ParakeetForTDT, ParakeetTDTConfig

path = Path(__file__).resolve().parents[1] / ".runtime" / "bark-model" / "model.bark"
with path.open("rb") as stream:
    size = int.from_bytes(stream.read(8), "little")
    header = json.loads(stream.read(size))
config = ParakeetTDTConfig.from_dict(json.loads(header["config"]))
with torch.device("meta"):
    model = ParakeetForTDT(config)
state = model.state_dict()
weights = {entry["n"] for entry in header["index"]}
print(f"Parameters: {sum(parameter.numel() for parameter in model.parameters()):,}")
print(f"State keys: {len(state)}; packed keys: {len(weights)}")
print(f"Missing keys: {sorted(set(state) - weights)[:40]}")
print(f"Unexpected keys: {sorted(weights - set(state))[:40]}")
print(f"Meta buffers outside state: {[name for name, buffer in model.named_buffers() if buffer.device.type == 'meta' and name not in state][:20]}")

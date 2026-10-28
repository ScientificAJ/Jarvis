"""Install the official Bark model and processor in Jarvis's private cache."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / ".runtime" / "huggingface"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import snapshot_download
from transformers import AutoProcessor, GenerationConfig

snapshot_download(
    repo_id="ConwayResearch/Underdog-Bark-3.0",
    revision="85db2ad18ab41e534a222ee253c29191d77ed919",
    local_dir=ROOT / ".runtime" / "bark-model",
    allow_patterns=["model.bark", "bark_loader.py", "NOTICE"],
)
# The official loader uses these NVIDIA processor files, but not NVIDIA weights.
AutoProcessor.from_pretrained("nvidia/parakeet-tdt-0.6b-v3")
GenerationConfig.from_pretrained("nvidia/parakeet-tdt-0.6b-v3")
print("Bark 3.0 model and processor are available locally.", flush=True)

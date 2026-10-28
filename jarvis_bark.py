"""Load the publisher's Bark 3.0 model once and transcribe audio locally."""
from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
import threading
import wave
import warnings

ROOT = Path(__file__).resolve().parent


class TranscriptionCancelled(Exception):
    """The browser no longer needs a chunk that was waiting for the model."""


def load_bark_without_duplicate_weights(loader, model_path, device):
    """Use the official decoder but avoid constructing a second FP32 model copy.

    The publisher's normal loader first decodes a full state dict and then
    allocates and initializes another full model before copying the weights.
    Creating the same architecture on the meta device and assigning its
    decoded tensors preserves the values while reducing peak memory.
    """
    import torch
    from transformers import GenerationConfig, ParakeetForTDT, ParakeetTDTConfig

    decoded, config = loader.load_state_dict(str(model_path))
    with torch.device("meta"):
        model = ParakeetForTDT(ParakeetTDTConfig.from_dict(config))
    expected = model.state_dict()
    if set(decoded) != set(expected):
        raise RuntimeError("Bark's weights do not match the expected model architecture.")
    for name, tensor in decoded.items():
        if tensor.shape != expected[name].shape:
            raise RuntimeError(f"Bark weight {name} has an unexpected shape.")
        # Match the original loader's .float() followed by PyTorch's copy into
        # the destination tensor's dtype, including integer tracking buffers.
        decoded[name] = tensor.float().to(dtype=expected[name].dtype)
    model.load_state_dict(decoded, strict=True, assign=True)
    del decoded, expected

    # This sinusoidal buffer is non-persistent, so it is not in the packed
    # weights. Recreate it exactly as the model's normal constructor does.
    positions = model.encoder.encode_positions
    positions.inv_freq = positions.compute_default_relative_positional_parameters(positions.config)
    remaining_meta = [name for name, value in list(model.named_parameters()) + list(model.named_buffers())
                      if value.device.type == "meta"]
    if remaining_meta:
        raise RuntimeError("Bark left uninitialized tensors: " + ", ".join(remaining_meta[:5]))
    model.generation_config = GenerationConfig.from_pretrained("nvidia/parakeet-tdt-0.6b-v3")
    return model.eval().to(device=device, dtype=torch.float32)


class BarkRecognizer:
    def __init__(self) -> None:
        self.state = "loading"
        self.detail = "Loading the local speech model. This may take a minute."
        self.device = None
        self.quantized = False
        self._lock = threading.Lock()
        self._model = None
        self._processor = None

    def load(self) -> None:
        try:
            os.environ.setdefault("HF_HOME", str(ROOT / ".runtime" / "huggingface"))
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            import torch
            from transformers import AutoProcessor

            requested = os.environ.get("JARVIS_DEVICE", "auto").lower()
            if requested not in {"auto", "cpu", "cuda", "mps"}:
                raise RuntimeError("JARVIS_DEVICE must be auto, cpu, cuda, or mps.")
            if requested == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("CUDA was requested, but an NVIDIA CUDA device is not available.")
            mps_available = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
            if requested == "mps" and not mps_available:
                raise RuntimeError("MPS was requested, but an Apple GPU is not available.")
            if requested == "auto":
                self.device = "cuda" if torch.cuda.is_available() else "mps" if mps_available else "cpu"
            else:
                self.device = requested
            model_dir = ROOT / ".runtime" / "bark-model"
            loader_path = model_dir / "bark_loader.py"
            spec = importlib.util.spec_from_file_location("jarvis_official_bark_loader", loader_path)
            if spec is None or spec.loader is None:
                raise RuntimeError("The Bark model loader is missing. Run Jarvis.cmd to install it.")
            loader = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(loader)
            print("Loading the local Bark 3.0 model...", flush=True)
            try:
                model = load_bark_without_duplicate_weights(loader, model_dir / "model.bark", self.device)
            except Exception:
                if requested != "auto" or self.device == "cpu":
                    raise
                print("The accelerator could not initialize; retrying on CPU...", flush=True)
                if self.device == "cuda":
                    torch.cuda.empty_cache()
                self.device = "cpu"
                model = load_bark_without_duplicate_weights(loader, model_dir / "model.bark", "cpu")
            self._model = model
            del model
            self.detail = "Preparing and warming up local speech recognition..."
            print(self.detail, flush=True)
            self._processor = AutoProcessor.from_pretrained("nvidia/parakeet-tdt-0.6b-v3", local_files_only=True)
            if self.device == "cpu":
                self._prepare_cpu(torch, loader, model_dir)
            # Warm the processor and model once at startup, not on the user's
            # first spoken request. This also surfaces device errors early.
            import numpy as np
            def warmup_error():
                try:
                    self._transcribe_samples(np.zeros(8000, dtype=np.float32), 16000)
                    return None
                except Exception as exc:
                    # Keep only text so a traceback cannot retain the old model
                    # while the full-precision fallback is being loaded.
                    return f"{type(exc).__name__}: {exc}"

            error = warmup_error()
            if error:
                if self.device == "cpu" and self.quantized:
                    print("Compact CPU recognition could not start; retrying in full precision...", flush=True)
                    self._reload_cpu(loader, model_dir)
                    self._transcribe_samples(np.zeros(8000, dtype=np.float32), 16000)
                elif requested != "auto" or self.device == "cpu":
                    raise RuntimeError(error)
                else:
                    self.detail = "Accelerator warmup failed; switching to CPU..."
                    print(self.detail, flush=True)
                    self._model = self._model.to("cpu")
                    self.device = "cpu"
                    self._prepare_cpu(torch, loader, model_dir)
                    error = warmup_error()
                    if error:
                        if not self.quantized:
                            raise RuntimeError(error)
                        print("Compact CPU recognition could not start; retrying in full precision...", flush=True)
                        self._reload_cpu(loader, model_dir)
                        self._transcribe_samples(np.zeros(8000, dtype=np.float32), 16000)
            mode = ", compact CPU" if self.quantized else ""
            self.state, self.detail = "ready", f"Local Bark 3.0 is ready ({self.device.upper()}{mode})."
            print(self.detail, flush=True)
        except Exception as exc:
            self.state, self.detail = "error", f"Could not load Bark 3.0: {exc}"
            print(self.detail, flush=True)

    def _reload_cpu(self, loader, model_dir) -> None:
        import gc
        self._model = None
        self.quantized = False
        gc.collect()
        self._model = load_bark_without_duplicate_weights(loader, model_dir / "model.bark", "cpu")

    def _prepare_cpu(self, torch, loader, model_dir) -> None:
        """Use compact dynamic INT8 linear layers when CPU inference supports them."""
        try:
            requested_threads = int(os.environ.get("JARVIS_CPU_THREADS", "4"))
        except ValueError as exc:
            raise RuntimeError("JARVIS_CPU_THREADS must be a positive whole number.") from exc
        if not 1 <= requested_threads <= 64:
            raise RuntimeError("JARVIS_CPU_THREADS must be between 1 and 64.")
        torch.set_num_threads(min(requested_threads, os.cpu_count() or 1))
        if os.environ.get("JARVIS_CPU_QUANTIZE", "1") == "0":
            return
        print("Preparing compact CPU speech recognition; this can take a little longer at startup...", flush=True)
        failed = False
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                torch.ao.quantization.quantize_dynamic(self._model, {torch.nn.Linear}, dtype=torch.qint8, inplace=True)
            self.quantized = True
        except Exception:
            failed = True
        if failed:
            # In-place conversion can partially modify a model before failing.
            # Reload instead of trying to use a partially converted model.
            print("Compact CPU mode is unavailable; loading full precision instead...", flush=True)
            self._reload_cpu(loader, model_dir)

    def _transcribe_samples(self, samples, sample_rate) -> str:
        """Same preprocessing and decoding as the official loader, with a cached processor."""
        import numpy as np
        import torch
        if sample_rate != 16000:
            import soxr
            samples = soxr.resample(samples, sample_rate, 16000)
        samples = np.concatenate([np.zeros(4000, np.float32), samples.astype(np.float32)])
        dev, dtype = next(self._model.parameters()).device, next(self._model.parameters()).dtype
        inputs = self._processor([samples], sampling_rate=16000, return_tensors="pt", padding=True)
        inputs = {key: (value.to(dev, dtype) if value.dtype.is_floating_point else value.to(dev))
                  for key, value in inputs.items()}
        with torch.inference_mode():
            output = self._model.generate(**inputs)
        return self._processor.batch_decode(output.sequences, skip_special_tokens=True)[0].strip()

    def transcribe(self, wav_bytes: bytes, cancelled=None) -> str:
        if self.state != "ready":
            raise RuntimeError(self.detail)
        import numpy as np

        try:
            with wave.open(io.BytesIO(wav_bytes), "rb") as recording:
                rate = recording.getframerate()
                frames = recording.getnframes()
                if (recording.getnchannels() != 1 or recording.getsampwidth() != 2 or
                        recording.getcomptype() != "NONE" or not 8000 <= rate <= 192000 or
                        frames == 0 or frames > rate * 15):
                    raise ValueError("Expected mono 16-bit WAV audio of up to 15 seconds.")
                raw = recording.readframes(frames)
                if len(raw) != frames * 2:
                    raise ValueError("Incomplete audio data.")
        except (wave.Error, EOFError) as exc:
            raise ValueError("Could not read the recorded audio.") from exc
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        # The model handles one chunk at a time. If the user interrupts, don't
        # spend time transcribing an abandoned chunk that is still in line.
        while not self._lock.acquire(timeout=0.25):
            if cancelled and cancelled():
                raise TranscriptionCancelled()
        try:
            if cancelled and cancelled():
                raise TranscriptionCancelled()
            return self._transcribe_samples(samples, rate)
        finally:
            self._lock.release()

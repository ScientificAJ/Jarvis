"""Local, incremental English transcription using a small streaming Zipformer."""
from __future__ import annotations

import os
from pathlib import Path
import re
import threading
import time

ROOT = Path(__file__).resolve().parent
MODEL_DIR = ROOT / ".runtime" / "streaming-model"
ENCODER = "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
DECODER = "decoder-epoch-99-avg-1-chunk-16-left-128.onnx"
JOINER = "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
TOKENS = "tokens.txt"


class _Session:
    def __init__(self, stream, rate):
        self.stream = stream
        self.rate = rate
        self.lock = threading.Lock()
        self.last_active = time.monotonic()
        self.next_sequence = 0
        self.total_samples = 0
        self.closed = False


class StreamingRecognizer:
    """Keep each utterance's decoder state while short audio packets arrive."""

    def __init__(self):
        self.state = "loading"
        self.detail = "Loading the local streaming speech model..."
        self._model = None
        self._np = None
        self._sessions = {}
        self._closed = {}
        self._sessions_lock = threading.Lock()
        self._decode_lock = threading.Lock()

    def load(self):
        try:
            import numpy as np
            import sherpa_onnx

            paths = [MODEL_DIR / name for name in (ENCODER, DECODER, JOINER, TOKENS)]
            if not all(path.is_file() for path in paths):
                raise RuntimeError("The streaming model is missing. Run the Jarvis launcher to prepare it.")
            try:
                threads = int(os.environ.get("JARVIS_CPU_THREADS", "1"))
            except ValueError as exc:
                raise RuntimeError("JARVIS_CPU_THREADS must be a positive whole number.") from exc
            if not 1 <= threads <= 16:
                raise RuntimeError("JARVIS_CPU_THREADS must be between 1 and 16.")
            print("Loading the lightweight local streaming speech model...", flush=True)
            self._model = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=str(paths[3]), encoder=str(paths[0]), decoder=str(paths[1]), joiner=str(paths[2]),
                num_threads=min(threads, os.cpu_count() or 1), sample_rate=16000, feature_dim=80,
                enable_endpoint_detection=False, decoding_method="greedy_search", provider="cpu")
            self._np = np
            warm = self._model.create_stream()
            warm.accept_waveform(16000, np.zeros(16000, dtype=np.float32))
            warm.input_finished()
            self._decode(warm)
            self.state, self.detail = "ready", "Local streaming speech recognition is ready (CPU)."
            print(self.detail, flush=True)
        except Exception as exc:
            self.state, self.detail = "error", f"Could not load the streaming speech model: {exc}"
            print(self.detail, flush=True)

    @staticmethod
    def _validate_id(stream_id):
        if not isinstance(stream_id, str) or not re.fullmatch(r"[0-9a-f]{32}", stream_id):
            raise ValueError("Invalid transcription stream.")

    def _prune_locked(self, now):
        for stream_id, session in list(self._sessions.items()):
            if now - session.last_active > 120:
                session.closed = True
                del self._sessions[stream_id]
                self._closed[stream_id] = now
        self._closed = {key: seen for key, seen in self._closed.items() if now - seen <= 120}
        while len(self._closed) > 256:
            del self._closed[next(iter(self._closed))]

    def _decode(self, stream):
        with self._decode_lock:
            while self._model.is_ready(stream):
                self._model.decode_stream(stream)
            return self._model.get_result(stream).strip()

    def accept(self, stream_id, rate, sequence, pcm):
        if self.state != "ready":
            raise RuntimeError(self.detail)
        self._validate_id(stream_id)
        if isinstance(rate, bool) or not isinstance(rate, int) or not 8000 <= rate <= 192000:
            raise ValueError("Invalid microphone sample rate.")
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
            raise ValueError("Invalid audio packet number.")
        if not pcm or len(pcm) % 2 or len(pcm) > rate * 2 * 2:
            raise ValueError("Invalid audio packet.")
        now = time.monotonic()
        with self._sessions_lock:
            self._prune_locked(now)
            if stream_id in self._closed:
                raise ValueError("This transcription stream has already ended.")
            session = self._sessions.get(stream_id)
            if session is None:
                if sequence != 0:
                    raise ValueError("An audio packet was missed.")
                if len(self._sessions) >= 8:
                    raise RuntimeError("Too many active speech requests. Please try again.")
                stream = self._model.create_stream()
                # A short lead-in protects the first syllable from clipping.
                stream.accept_waveform(rate, self._np.zeros(round(rate * 0.25), dtype=self._np.float32))
                session = _Session(stream, rate)
                self._sessions[stream_id] = session
            session.last_active = now
        with session.lock:
            if session.closed:
                raise ValueError("This transcription stream has already ended.")
            if session.rate != rate or session.next_sequence != sequence:
                raise ValueError("An audio packet was missed or arrived out of order.")
            samples = self._np.frombuffer(pcm, dtype="<i2").astype(self._np.float32) / 32768.0
            if session.total_samples + len(samples) > rate * 3600:
                raise ValueError("This speech request is too long.")
            session.stream.accept_waveform(rate, samples)
            session.total_samples += len(samples)
            session.next_sequence += 1
            return self._decode(session.stream)

    def finish(self, stream_id, sequence):
        self._validate_id(stream_id)
        if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 1:
            raise ValueError("Invalid audio packet number.")
        now = time.monotonic()
        with self._sessions_lock:
            self._prune_locked(now)
            session = self._sessions.pop(stream_id, None)
            self._closed[stream_id] = now
        if session is None:
            raise ValueError("The transcription stream has expired or was cancelled.")
        with session.lock:
            if session.closed or session.next_sequence != sequence:
                raise ValueError("An audio packet was missed or the stream was cancelled.")
            session.closed = True
            session.stream.accept_waveform(session.rate, self._np.zeros(round(session.rate * 0.66), dtype=self._np.float32))
            session.stream.input_finished()
            return self._decode(session.stream)

    def cancel(self, stream_id):
        self._validate_id(stream_id)
        now = time.monotonic()
        with self._sessions_lock:
            self._prune_locked(now)
            session = self._sessions.pop(stream_id, None)
            self._closed[stream_id] = now
            if session is not None:
                session.closed = True

import io
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis_bark import BarkRecognizer, TranscriptionCancelled


def recording():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(bytes(1600))
    return buf.getvalue()


class BarkQueueTests(unittest.TestCase):
    def test_cancelled_waiting_chunk_does_not_run(self):
        recognizer = BarkRecognizer()
        recognizer.state = "ready"
        ran = threading.Event()
        recognizer._transcribe_samples = lambda samples, rate: ran.set()
        cancelled = threading.Event()
        result = []

        def wait_for_model():
            try:
                recognizer.transcribe(recording(), cancelled=cancelled.is_set)
            except TranscriptionCancelled:
                result.append("cancelled")

        recognizer._lock.acquire()
        try:
            worker = threading.Thread(target=wait_for_model)
            worker.start()
            cancelled.set()
            worker.join(2)
            self.assertFalse(worker.is_alive(), "a cancelled queued chunk should leave promptly")
            self.assertEqual(result, ["cancelled"])
            self.assertFalse(ran.is_set(), "do not decode a cancelled request")
        finally:
            recognizer._lock.release()

    def test_cancelled_chunk_releases_the_model_lock(self):
        recognizer = BarkRecognizer()
        recognizer.state = "ready"
        with self.assertRaises(TranscriptionCancelled):
            recognizer.transcribe(recording(), cancelled=lambda: True)
        self.assertTrue(recognizer._lock.acquire(blocking=False))
        recognizer._lock.release()


class BarkCpuModeTests(unittest.TestCase):
    def fake_torch(self, quantize):
        return SimpleNamespace(set_num_threads=Mock(), nn=SimpleNamespace(Linear=type("Linear", (), {})),
                               ao=SimpleNamespace(quantization=SimpleNamespace(quantize_dynamic=quantize)),
                               qint8="qint8")

    def test_uses_compact_cpu_mode_with_bounded_threads(self):
        quantize = Mock()
        torch = self.fake_torch(quantize)
        recognizer = BarkRecognizer()
        recognizer._model = object()
        with patch.dict("os.environ", {}, clear=True), patch("os.cpu_count", return_value=12):
            recognizer._prepare_cpu(torch, object(), Path("model-dir"))
        torch.set_num_threads.assert_called_once_with(4)
        self.assertTrue(recognizer.quantized)
        self.assertTrue(quantize.call_args.kwargs["inplace"])

    def test_conversion_failure_reloads_a_clean_full_precision_model(self):
        torch = self.fake_torch(Mock(side_effect=RuntimeError("unsupported")))
        recognizer = BarkRecognizer()
        recognizer._model = object()
        clean_model = object()
        with patch.dict("os.environ", {}, clear=True), \
             patch("jarvis_bark.load_bark_without_duplicate_weights", return_value=clean_model):
            recognizer._prepare_cpu(torch, object(), Path("model-dir"))
        self.assertIs(recognizer._model, clean_model)
        self.assertFalse(recognizer.quantized)

    def test_full_precision_can_be_requested(self):
        quantize = Mock()
        torch = self.fake_torch(quantize)
        recognizer = BarkRecognizer()
        with patch.dict("os.environ", {"JARVIS_CPU_QUANTIZE": "0"}, clear=True):
            recognizer._prepare_cpu(torch, object(), Path("model-dir"))
        quantize.assert_not_called()
        self.assertFalse(recognizer.quantized)


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvis_streaming
from jarvis_streaming import BPE_VOCAB, HOTWORDS, StreamingRecognizer, parse_hotwords


class FakeStream:
    def __init__(self):
        self.parts = []
        self.ready = False
        self.finished = False

    def accept_waveform(self, rate, samples):
        self.parts.append((rate, np.asarray(samples).copy()))
        self.ready = True

    def input_finished(self):
        self.finished = True


class FakeModel:
    def __init__(self):
        self.streams = []
        self.decodes = 0

    def create_stream(self):
        stream = FakeStream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream):
        return stream.ready

    def decode_stream(self, stream):
        self.decodes += 1
        stream.ready = False

    def get_result(self, stream):
        return f"decoded {len(stream.parts) - 1} packets"


class StreamingRecognizerTests(unittest.TestCase):
    def setUp(self):
        self.recognizer = StreamingRecognizer()
        self.recognizer.state = "ready"
        self.recognizer._np = np
        self.recognizer._model = FakeModel()
        self.stream = "a" * 32
        self.pcm = struct.pack("<3h", -32768, 0, 32767)

    def test_ordered_audio_is_decoded_incrementally_and_finalized(self):
        partial = self.recognizer.accept(self.stream, 16000, 0, self.pcm)
        self.assertEqual(partial, "decoded 1 packets")
        self.assertEqual(self.recognizer.accept(self.stream, 16000, 1, self.pcm), "decoded 2 packets")
        final = self.recognizer.finish(self.stream, 2)
        self.assertEqual(final, "decoded 3 packets")  # includes final padding
        stream = self.recognizer._model.streams[0]
        self.assertTrue(stream.finished)
        np.testing.assert_allclose(stream.parts[1][1], [-1, 0, 32767 / 32768])
        np.testing.assert_array_equal(stream.parts[1][1], stream.parts[2][1])
        self.assertEqual(self.recognizer._model.decodes, 3)
        with self.assertRaises(ValueError):
            self.recognizer.accept(self.stream, 16000, 0, self.pcm)

    def test_missing_or_reordered_packets_are_rejected(self):
        with self.assertRaises(ValueError):
            self.recognizer.accept(self.stream, 16000, 1, self.pcm)
        self.recognizer.accept(self.stream, 16000, 0, self.pcm)
        with self.assertRaises(ValueError):
            self.recognizer.accept(self.stream, 16000, 2, self.pcm)
        with self.assertRaises(ValueError):
            self.recognizer.accept(self.stream, 44100, 1, self.pcm)
        self.assertEqual(self.recognizer.accept(self.stream, 16000, 1, self.pcm), "decoded 2 packets")

    def test_cancel_before_or_after_first_packet_prevents_resurrection(self):
        self.recognizer.cancel(self.stream)
        with self.assertRaises(ValueError):
            self.recognizer.accept(self.stream, 16000, 0, self.pcm)
        other = "b" * 32
        self.recognizer.accept(other, 16000, 0, self.pcm)
        self.recognizer.cancel(other)
        with self.assertRaises(ValueError):
            self.recognizer.finish(other, 1)
        with self.assertRaises(ValueError):
            self.recognizer.accept(other, 16000, 0, self.pcm)

    def test_inactive_sessions_are_reaped(self):
        with patch("jarvis_streaming.time.monotonic", return_value=100):
            self.recognizer.accept(self.stream, 16000, 0, self.pcm)
        with patch("jarvis_streaming.time.monotonic", return_value=221):
            with self.assertRaises(ValueError):
                self.recognizer.accept(self.stream, 16000, 1, self.pcm)
            self.assertNotIn(self.stream, self.recognizer._sessions)

    def test_packet_sizes_and_identifiers_are_validated(self):
        for stream_id, rate, seq, pcm in [("bad", 16000, 0, self.pcm),
                                         (self.stream, 10, 0, self.pcm),
                                         (self.stream, 16000, 0, b"\x00"),
                                         (self.stream, 16000, -1, self.pcm)]:
            with self.subTest(stream_id=stream_id, rate=rate, seq=seq):
                with self.assertRaises(ValueError):
                    self.recognizer.accept(stream_id, rate, seq, pcm)


class HotwordTests(unittest.TestCase):
    def test_decoder_receives_hints_and_can_fall_back_to_general_decoding(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".runtime").mkdir()
            model = root / "model"
            model.mkdir()
            for name in (jarvis_streaming.ENCODER, jarvis_streaming.DECODER,
                         jarvis_streaming.JOINER, jarvis_streaming.TOKENS):
                (model / name).touch()
            hotwords = root / "words.txt"
            hotwords.write_text("# comment\n phishing \nS Q L injection\n", encoding="utf-8")
            vocab = root / "vocab.txt"
            vocab.touch()

            for enabled in (True, False):
                with self.subTest(enabled=enabled):
                    seen = {}

                    def create_model(**options):
                        seen.update(options)
                        if "hotwords_file" in options:
                            seen["file_contents"] = Path(options["hotwords_file"]).read_text(encoding="utf-8")
                        return FakeModel()

                    sherpa = SimpleNamespace(OnlineRecognizer=SimpleNamespace(from_transducer=create_model))
                    with patch.dict(sys.modules, {"sherpa_onnx": sherpa}), \
                         patch.dict("os.environ", {"JARVIS_CYBER_HOTWORDS": "1" if enabled else "0"}), \
                         patch.object(jarvis_streaming, "ROOT", root), \
                         patch.object(jarvis_streaming, "MODEL_DIR", model), \
                         patch.object(jarvis_streaming, "HOTWORDS", hotwords), \
                         patch.object(jarvis_streaming, "BPE_VOCAB", vocab):
                        recognizer = StreamingRecognizer()
                        recognizer.load()

                    self.assertEqual(recognizer.state, "ready", recognizer.detail)
                    if enabled:
                        self.assertEqual(seen["decoding_method"], "modified_beam_search")
                        self.assertEqual(seen["modeling_unit"], "bpe")
                        self.assertEqual(seen["file_contents"], "PHISHING\nS Q L INJECTION\n")
                        self.assertFalse(Path(seen["hotwords_file"]).exists())
                    else:
                        self.assertEqual(seen["decoding_method"], "greedy_search")
                        self.assertNotIn("hotwords_file", seen)

    def test_comments_duplicates_and_case_are_handled(self):
        self.assertEqual(parse_hotwords("# threats\n phishing \nPhishing\nS Q L injection\n"),
                         ["PHISHING", "S Q L INJECTION"])

    def test_unsupported_characters_are_rejected_before_loading_native_code(self):
        for entry in ("CVE-2026", "DNS/HTTPS", "a" * 121):
            with self.subTest(entry=entry):
                with self.assertRaisesRegex(ValueError, "line 1"):
                    parse_hotwords(entry)

    def test_hotword_count_is_bounded(self):
        # Use distinct, valid short phrases to exercise the count bound.
        terms = (f"TERM {chr(65 + n // (26 * 26))}{chr(65 + (n // 26) % 26)}{chr(65 + n % 26)}"
                 for n in range(2001))
        with self.assertRaisesRegex(ValueError, "2,000"):
            parse_hotwords("\n".join(terms))

    def test_packaged_vocabulary_contains_representative_terms(self):
        terms = parse_hotwords(HOTWORDS.read_text(encoding="utf-8"))
        self.assertGreater(len(terms), 650)
        self.assertEqual(len(terms), len(set(terms)))
        for term in ("PHISHING", "RANSOMWARE", "CROSS SITE SCRIPTING", "S Q L INJECTION", "C V E"):
            self.assertIn(term, terms)
        self.assertGreater(len(BPE_VOCAB.read_text(encoding="utf-8").splitlines()), 400)


if __name__ == "__main__":
    unittest.main()

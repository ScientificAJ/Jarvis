from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis_streaming import StreamingRecognizer


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


if __name__ == "__main__":
    unittest.main()

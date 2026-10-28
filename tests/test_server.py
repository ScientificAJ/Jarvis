import base64
import http.client
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis_server import CHAT_MODEL, VOICE_MODEL, JarvisHTTPServer, build_chat_payload, main


class FakeRecognizer:
    state = "ready"
    detail = "Test recognizer"

    def load(self):
        self.state = "ready"

    def accept(self, stream_id, rate, sequence, body):
        return "local transcript"

    def finish(self, stream_id, sequence):
        return "local transcript"

    def cancel(self, stream_id):
        pass


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def upstream(path, payload, key):
            self.calls.append((path, payload, key))
            if path.endswith("completions"):
                return json.dumps({"choices": [{"message": {"content": "At your service."}}]}).encode(), "application/json"
            return b"fake mp3", "audio/mpeg"

        self.server = JarvisHTTPServer(("127.0.0.1", 0), FakeRecognizer(), opener=upstream)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, path, body, content_type="application/json", origin=None, key="test-key", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        request_headers = {
            "Content-Type": content_type,
            "Origin": self.origin if origin is None else origin,
            "X-OpenRouter-Key": key,
        }
        request_headers.update(headers or {})
        connection.request("POST", path, body, request_headers)
        result = connection.getresponse()
        data = result.read()
        connection.close()
        return result.status, data

    def test_complete_voice_and_vision_request_contract(self):
        stream_id = "a" * 32
        status, body = self.post("/api/transcribe/stream", b"\x00\x00", content_type="application/octet-stream",
                                 headers={"X-Jarvis-Stream": stream_id, "X-Jarvis-Sample-Rate": "16000",
                                          "X-Jarvis-Sequence": "0"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["text"], "local transcript")
        status, body = self.post("/api/transcribe/finish", {"stream": stream_id, "sequence": 1})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["text"], "local transcript")
        screen = "data:image/jpeg;base64," + base64.b64encode(b"jpeg data").decode()
        data = {"text": "What is this?", "profile": "Be concise.", "history": [
            {"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hello."}],
            "frames": [{"image": screen, "age_seconds": 0.5}]}
        status, body = self.post("/api/chat", data)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["text"], "At your service.")
        path, payload, key = self.calls[-1]
        self.assertEqual((path, key, payload["model"]), ("/chat/completions", "test-key", CHAT_MODEL))
        self.assertIn("misheard, missing, repeated", payload["messages"][0]["content"])
        self.assertIn("commands, flags, code, IP addresses", payload["messages"][0]["content"])
        self.assertEqual(payload["reasoning"], {"enabled": True, "exclude": True})
        self.assertEqual(payload["messages"][-1]["content"][0]["text"], "What is this?")
        self.assertEqual(payload["messages"][-1]["content"][-1]["image_url"]["url"], screen)
        self.assertEqual(payload["messages"][-3]["content"], "Hello")
        status, body = self.post("/api/speech", {"text": "At your service.", "voice": ""})
        self.assertEqual(status, 200)
        self.assertEqual(body, b"fake mp3")
        path, payload, key = self.calls[-1]
        self.assertEqual((path, payload["model"], payload["response_format"]), ("/audio/speech", VOICE_MODEL, "mp3"))
        self.assertNotIn("voice", payload, "Fish's default voice must not be replaced by an invented preset")

    def test_cross_origin_requests_are_rejected(self):
        status, body = self.post("/api/chat", {"text": "hello"}, origin="https://example.com")
        self.assertEqual(status, 403)
        status, _ = self.post("/api/transcribe/stream", b"\x00\x00", content_type="application/octet-stream",
                              origin="https://example.com", headers={"X-Jarvis-Stream": "a" * 32,
                              "X-Jarvis-Sample-Rate": "16000", "X-Jarvis-Sequence": "0"})
        self.assertEqual(status, 403)
        self.assertEqual(self.calls, [])

    def test_invalid_or_excessive_frames_are_rejected(self):
        with self.assertRaises(ValueError):
            build_chat_payload({"text": "hello", "frames": [{"image": "data:image/jpeg;base64,%%%", "age_seconds": 0}]})
        with self.assertRaises(ValueError):
            build_chat_payload({"text": "hello", "frames": [{"image": "x"}] * 9})

    def test_screen_timing_and_interrupted_history_are_preserved(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"jpeg").decode()
        payload = build_chat_payload({"text": "No, the earlier one", "history": [
            {"role": "assistant", "content": "Here is my explanation.", "interrupted": True, "spoken_seconds": 2.5}],
            "screen_context": {"duration_seconds": 18, "samples": 9, "changes": 3, "partial": True},
            "frames": [{"image": image, "age_seconds": 15, "offset_seconds": -0.2, "phase": "before"},
                       {"image": image, "age_seconds": 12, "offset_seconds": 3, "phase": "during"},
                       {"image": image, "age_seconds": 1, "offset_seconds": 14, "phase": "after"}]})
        self.assertIn("interrupted after approximately 2.5 seconds", payload["messages"][-2]["content"])
        parts = payload["messages"][-1]["content"]
        self.assertIn("interrupted", parts[1]["text"])
        self.assertIn("just before", parts[2]["text"])
        self.assertIn("during the user's request", parts[4]["text"])
        self.assertIn("after the user stopped", parts[6]["text"])
        with self.assertRaises(ValueError):
            build_chat_payload({"text": "test", "frames": [
                {"image": image, "age_seconds": 1, "offset_seconds": 2},
                {"image": image, "age_seconds": 1, "offset_seconds": 1}]})

    def test_previous_screen_frames_are_labeled_and_ordered(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"jpeg").decode()
        payload = build_chat_payload({"text": "I meant the earlier screen", "screen_context": {
            "duration_seconds": 3, "samples": 2, "changes": 1, "partial": False, "previous_frames": 1},
            "frames": [{"image": image, "age_seconds": 15, "offset_seconds": -12, "phase": "previous"},
                       {"image": image, "age_seconds": 1, "offset_seconds": 2, "phase": "during"}]})
        parts = payload["messages"][-1]["content"]
        self.assertIn("previous turn", parts[1]["text"])
        self.assertIn("from the previous turn", parts[2]["text"])
        with self.assertRaises(ValueError):
            build_chat_payload({"text": "test", "frames": [
                {"image": image, "age_seconds": 1, "offset_seconds": -1, "phase": "previous"}]})

    def test_two_previous_and_six_current_frames_fit(self):
        image = "data:image/jpeg;base64," + base64.b64encode(b"jpeg").decode()
        frames = [{"image": image, "age_seconds": 20, "offset_seconds": offset, "phase": "previous"}
                  for offset in (-20, -10)]
        frames += [{"image": image, "age_seconds": 1, "offset_seconds": offset, "phase": "during"}
                   for offset in range(6)]
        payload = build_chat_payload({"text": "compare", "frames": frames,
                                      "screen_context": {"previous_frames": 2, "samples": 12, "changes": 4,
                                                         "duration_seconds": 6, "partial": False}})
        parts = payload["messages"][-1]["content"]
        self.assertEqual(sum(part["type"] == "image_url" for part in parts), 8)

    def test_launcher_opens_system_default_browser(self):
        class StubServer:
            def __init__(self, address, recognizer):
                self.address = address

            def serve_forever(self, **kwargs):
                pass

            def server_close(self):
                pass

        events = []

        class StartupRecognizer(FakeRecognizer):
            state = "loading"

            def load(self):
                events.append("loaded")
                self.state = "ready"

        with patch("jarvis_server.JarvisHTTPServer", StubServer), \
             patch("jarvis_server.StreamingRecognizer", StartupRecognizer), \
             patch("jarvis_server.request_api_key", side_effect=lambda: events.append("key") or "test-key"), \
             patch("jarvis_server.webbrowser.open", side_effect=lambda url: events.append("browser") or True) as open_browser, \
             patch("sys.argv", ["jarvis_server.py", "--port", "47123"]), \
             patch.dict("os.environ", {"JARVIS_NO_BROWSER": "0"}):
            self.assertEqual(main(), 0)
        self.assertEqual(events, ["key", "loaded", "browser"])
        open_browser.assert_called_once_with("http://127.0.0.1:47123/")

    def test_browser_does_not_open_if_model_fails_to_load(self):
        class StubServer:
            def __init__(self, address, recognizer):
                pass
            def server_close(self):
                pass

        class FailedRecognizer(FakeRecognizer):
            def load(self):
                self.state = "error"
                self.detail = "Model load failed."

        with patch("jarvis_server.JarvisHTTPServer", StubServer), \
             patch("jarvis_server.StreamingRecognizer", FailedRecognizer), \
             patch("jarvis_server.request_api_key", return_value="test-key"), \
             patch("jarvis_server.webbrowser.open") as open_browser, \
             patch("sys.argv", ["jarvis_server.py", "--port", "47123"]), \
             patch.dict("os.environ", {"JARVIS_NO_BROWSER": "0"}):
            self.assertEqual(main(), 1)
        open_browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()

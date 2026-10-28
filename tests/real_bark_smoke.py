"""Exercise the actual local model through the HTTP endpoint with a WAV sample."""
import http.client
import json
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis_bark import BarkRecognizer
from jarvis_server import JarvisHTTPServer


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tests/real_bark_smoke.py <mono 16-bit WAV, <=15s>")
    sample = Path(sys.argv[1]).read_bytes()
    recognizer = BarkRecognizer()
    started = time.monotonic()
    recognizer.load()
    if recognizer.state != "ready":
        raise SystemExit(recognizer.detail)
    print(f"Model loaded on {recognizer.device} in {time.monotonic() - started:.1f}s.", flush=True)
    server = JarvisHTTPServer(("127.0.0.1", 0), recognizer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=600)
        started = time.monotonic()
        conn.request("POST", "/api/transcribe", sample, {"Content-Type": "audio/wav", "Origin": f"http://127.0.0.1:{port}"})
        response = conn.getresponse()
        body = json.loads(response.read())
        if response.status != 200 or not body.get("text"):
            raise SystemExit(f"Transcription failed: {body}")
        print(f"Transcription in {time.monotonic() - started:.1f}s: {body['text']}", flush=True)
        conn.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()

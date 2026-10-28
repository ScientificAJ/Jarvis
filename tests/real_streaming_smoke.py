"""Run the actual local streaming recognizer on a mono 16-bit WAV file."""
from pathlib import Path
import sys
import time
import uuid
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis_streaming import StreamingRecognizer


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python tests/real_streaming_smoke.py <mono 16-bit WAV>")
    with wave.open(sys.argv[1], "rb") as recording:
        if recording.getnchannels() != 1 or recording.getsampwidth() != 2 or recording.getcomptype() != "NONE":
            raise SystemExit("Expected mono 16-bit PCM WAV audio.")
        rate = recording.getframerate()
        frames = recording.getnframes()
        pcm = recording.readframes(frames)
    recognizer = StreamingRecognizer()
    started = time.monotonic()
    recognizer.load()
    if recognizer.state != "ready":
        raise SystemExit(recognizer.detail)
    print(f"Model ready in {time.monotonic() - started:.2f}s.", flush=True)
    stream = uuid.uuid4().hex
    packet_size = max(2, (rate // 4) * 2)
    started = time.monotonic()
    sequence = 0
    saw_partial = False
    for offset in range(0, len(pcm), packet_size):
        result = recognizer.accept(stream, rate, sequence, pcm[offset:offset + packet_size])
        sequence += 1
        if result["text"] and offset + packet_size < len(pcm):
            saw_partial = True
    transcript = recognizer.finish(stream, sequence)
    print(f"{frames / rate:.2f}s of audio processed in {time.monotonic() - started:.2f}s.")
    print(f"Partial text before end of audio: {saw_partial}")
    print(f"Transcript: {transcript}")
    if not transcript:
        raise SystemExit("No speech was recognized.")


if __name__ == "__main__":
    main()

const assert = require("node:assert/strict");
const { SpeechSegmenter, InterruptionDetector, pcm16Bytes } = require("../static/audio-core.js");

function block(length, level) {
  return new Float32Array(length).fill(level);
}

// Switching from interruption detection to recording retains the words that
// triggered the interruption instead of clipping the beginning.
{
  const rate = 8000, size = 800;
  const chunks = [];
  let recording = false;
  const segmenter = new SpeechSegmenter({ sampleRate: rate, onAudio: x => chunks.push(x), onFinish: () => {} });
  const detector = new InterruptionDetector({ sampleRate: rate, threshold: 0.009, onInterrupt: blocks => {
    recording = true;
    for (const captured of blocks) segmenter.push(captured);
  }});
  for (let i = 0; i < 6; i++) {
    const samples = block(size, 0.08);
    if (recording) segmenter.push(samples);
    else detector.push(samples, block(size, 0), false);
  }
  segmenter.push(block(rate * 2, 0));
  assert.equal(chunks.reduce((total, chunk) => total + chunk.filter(x => x > 0.05).length, 0), 6 * size,
    "all samples of the correction must be retained");
}

// The same echo rejection works with real worklet-sized buffers at 48 kHz.
{
  const rate = 48000, frameSize = 4096;
  const reference = new Float32Array(rate * 2);
  let seed = 987;
  for (let i = 0; i < reference.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    reference[i] = ((seed / 0xffffffff) * 2 - 1) * 0.22;
  }
  for (const lag of [4800, 4801, 4803, 4805]) {
    let interruptions = 0;
    const detector = new InterruptionDetector({ sampleRate: rate, threshold: 0.004, onInterrupt: () => interruptions++ });
    for (let start = 0; start < rate; start += frameSize) {
      const mic = new Float32Array(frameSize);
      for (let i = 0; i < frameSize; i++) if (start + i >= lag) mic[i] = reference[start + i - lag] * 0.5;
      detector.push(mic, reference.subarray(start, start + frameSize), true);
    }
    assert.equal(interruptions, 0, `48 kHz speaker echo at delay ${lag} should not interrupt the assistant`);
    for (let start = rate; start < rate + 24000 && !interruptions; start += frameSize) {
      const mic = new Float32Array(frameSize);
      for (let i = 0; i < frameSize; i++) {
        mic[i] = reference[start + i - lag] * 0.5 + 0.12 * Math.sin((start + i) * 0.04);
      }
      detector.push(mic, reference.subarray(start, start + frameSize), true);
    }
    assert.equal(interruptions, 1, `speech over the 48 kHz echo at delay ${lag} must interrupt`);
  }
}

// Playback leakage should not interrupt, but new speech over playback should.
{
  const rate = 8000, frameSize = 800, lag = 800;
  const reference = new Float32Array(rate * 3);
  let seed = 123;
  for (let i = 0; i < reference.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    reference[i] = ((seed / 0xffffffff) * 2 - 1) * 0.25;
  }
  let interruptions = 0, candidates = 0, captured = [];
  const detector = new InterruptionDetector({ sampleRate: rate, threshold: 0.009, onCandidate: () => candidates++, onInterrupt: blocks => {
    interruptions++;
    captured = blocks;
  }});
  for (let start = 0; start < rate; start += frameSize) {
    const mic = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) if (start + i >= lag) mic[i] = reference[start + i - lag] * 0.3;
    detector.push(mic, reference.subarray(start, start + frameSize), true);
  }
  assert.equal(interruptions, 0, "the assistant's own output must not be treated as speech");
  assert.equal(candidates, 0);
  for (let start = rate; start < rate + 4000; start += frameSize) {
    const mic = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) mic[i] = reference[start + i - lag] * 0.3 + 0.1 * Math.sin((start + i) * 0.17);
    detector.push(mic, reference.subarray(start, start + frameSize), true);
    if (interruptions) break;
  }
  assert.equal(interruptions, 1);
  assert.equal(candidates, 1, "identify the start before the interrupt is confirmed");
  assert.ok(captured.reduce((sum, part) => sum + part.length, 0) >= rate * 0.20, "keep the start of the user's correction");
}

// Two minutes of continuous speech are sent incrementally without dropping
// samples, and the request finishes only after two seconds of silence.
{
  const chunks = [];
  let starts = 0;
  let finishes = 0;
  const rate = 16000;
  const segmenter = new SpeechSegmenter({
    sampleRate: rate, onStart: () => starts++, onAudio: x => chunks.push(x), onFinish: () => finishes++
  });
  for (let i = 0; i < 120; i++) segmenter.push(block(rate, 0.1));
  assert.equal(chunks.length, 480);
  assert.ok(chunks.every(c => c.length === rate / 4));
  assert.equal(chunks.reduce((sum, c) => sum + c.length, 0), 120 * rate);
  segmenter.push(block(rate, 0));
  assert.equal(finishes, 0);
  segmenter.push(block(rate, 0));
  assert.equal(finishes, 1);
  assert.equal(starts, 1);
  assert.equal(chunks.reduce((sum, c) => sum + c.length, 0), 122 * rate);
}

// Short pauses stay in the stream; they do not end the request.
{
  const rate = 1000;
  const chunks = [];
  let finished = 0;
  const segmenter = new SpeechSegmenter({ sampleRate: rate, onAudio: x => chunks.push(x), onFinish: () => finished++ });
  segmenter.push(block(12000, 0.1));
  segmenter.push(block(700, 0));
  assert.equal(finished, 0);
  segmenter.push(block(4500, 0.1));
  segmenter.push(block(2000, 0));
  assert.equal(finished, 1);
  const all = chunks.flatMap(c => Array.from(c));
  assert.equal(all.length, 19200);
  assert.equal(all[12000], 0, "a pause within speech should remain in the audio");
}

// A short request is sent while the user is still speaking.
{
  const chunks = [];
  let finished = 0;
  const segmenter = new SpeechSegmenter({ sampleRate: 1000, onAudio: x => chunks.push(x), onFinish: () => finished++ });
  segmenter.push(block(2400, 0.1));
  assert.equal(chunks.length, 9, "audio packets should be sent before the user stops");
  segmenter.push(block(1000, 0));
  assert.equal(finished, 0, "do not submit the request after a one-second pause");
  segmenter.push(block(1000, 0));
  assert.equal(finished, 1);
  assert.equal(chunks.reduce((sum, part) => sum + part.length, 0), 4400);
}

// When a longer pause is followed by more speech, both parts stay in the same
// turn, in order, and neither part of the voice is discarded or duplicated.
{
  const chunks = [];
  let finished = 0;
  const segmenter = new SpeechSegmenter({ sampleRate: 1000, onAudio: x => chunks.push(x), onFinish: () => finished++ });
  segmenter.push(block(1400, 0.1));
  segmenter.push(block(1200, 0));
  segmenter.push(block(800, 0.2));
  segmenter.push(block(2000, 0));
  assert.equal(finished, 1);
  const all = chunks.flatMap(c => Array.from(c));
  assert.equal(all.filter(v => v > 0.05 && v < 0.15).length, 1400);
  assert.equal(all.filter(v => v > 0.15).length, 800);
  assert.equal(all.length, 5400);
}

// Muting mid-sentence flushes the remainder instead of losing it.
{
  const chunks = [];
  let finished = 0;
  const segmenter = new SpeechSegmenter({ sampleRate: 1000, onAudio: x => chunks.push(x), onFinish: () => finished++ });
  segmenter.push(block(1300, 0.1));
  segmenter.finish();
  assert.equal(finished, 1);
  assert.equal(chunks.reduce((sum, part) => sum + part.length, 0), 1300);
}

// Streaming packets use the same signed little-endian PCM as WAV files.
{
  const view = new DataView(pcm16Bytes(new Float32Array([-1, 0, 1])));
  assert.equal(view.getInt16(0, true), -32768);
  assert.equal(view.getInt16(2, true), 0);
  assert.equal(view.getInt16(4, true), 32767);
}

// Steady background noise measured at the end of a request must not cancel
// the answer, while a stronger interruption can still be heard.
{
  const rate = 8000;
  let interruptions = 0;
  const detector = new InterruptionDetector({ sampleRate: rate, onInterrupt: () => interruptions++ });
  detector.setAmbientLevel(0.03);
  for (let i = 0; i < 10; i++) detector.push(block(800, 0.03), block(800, 0), false);
  assert.equal(interruptions, 0);
  for (let i = 0; i < 4 && !interruptions; i++) detector.push(block(800, 0.12), block(800, 0), false);
  assert.equal(interruptions, 1);
}

console.log("Audio capture and PCM tests passed.");

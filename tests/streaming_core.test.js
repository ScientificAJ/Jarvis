const assert = require("node:assert/strict");
const { StreamingTranscription, PendingTranscription } = require("../static/audio-core.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  const first = deferred(), events = [], partials = [];
  const stream = new StreamingTranscription({
    id: "a".repeat(32), sampleRate: 16000,
    send: async (id, rate, sequence, bytes) => {
      events.push(["send", sequence, bytes.byteLength]);
      return sequence === 0 ? first.promise : { text: "hello there" };
    },
    finalize: async (id, sequence) => { events.push(["finish", sequence]); return { text: "hello there" }; },
    cancel: id => { events.push(["cancel", id]); },
    onPartial: text => partials.push(text)
  });
  stream.push(new Float32Array(4000).fill(0.1));
  stream.push(new Float32Array(4000).fill(0.2));
  const finished = stream.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [["send", 0, 8000]], "do not send packets out of order");
  first.resolve({ text: "hello" });
  assert.deepEqual(await finished, { text: "hello there" });
  assert.deepEqual(events, [["send", 0, 8000], ["send", 1, 8000], ["finish", 2]]);
  assert.deepEqual(partials, ["hello", "hello there"]);

  const busy = deferred(), cancelled = [], sent = [];
  const interrupted = new StreamingTranscription({
    id: "b".repeat(32), sampleRate: 16000,
    send: async (id, rate, seq) => { sent.push(seq); return busy.promise; },
    finalize: () => { throw new Error("must not finalize"); },
    cancel: id => cancelled.push(id)
  });
  interrupted.push(new Float32Array(4000));
  interrupted.push(new Float32Array(4000));
  await new Promise(resolve => setImmediate(resolve));
  interrupted.cancel();
  busy.resolve({ text: "old" });
  const result = await interrupted.finish();
  assert.equal(result.error.name, "AbortError");
  assert.deepEqual(sent, [0], "do not send queued packets after interruption");
  assert.deepEqual(cancelled, ["b".repeat(32)]);

  const errors = [], cancelledSlow = [];
  const slow = new StreamingTranscription({
    id: "c".repeat(32), sampleRate: 16000,
    send: () => { throw new Error("must not send"); },
    finalize: () => { throw new Error("must not finalize"); },
    cancel: id => cancelledSlow.push(id), onError: error => errors.push(error.message)
  });
  slow.push(new Float32Array(16000 * 31));
  assert.match((await slow.finish()).error.message, /cannot keep up/);
  assert.equal(errors.length, 1);
  assert.equal(cancelledSlow.length, 1);

  // Resuming before an older stream's final result arrives must not submit
  // the first part alone; the complete request keeps both parts in order.
  const pending = new PendingTranscription(), old = deferred();
  pending.add(old.promise);
  const stale = pending.collect();
  pending.resume();
  pending.add(Promise.resolve({ text: "continued" }));
  const combined = pending.collect();
  old.resolve({ text: "original" });
  assert.equal(await stale, null);
  assert.deepEqual(await combined, [{ text: "original" }, { text: "continued" }]);
  console.log("Streaming transcription queue tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });

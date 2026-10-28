const assert = require("node:assert/strict");
const { speechSegments, playSpeechQueue } = require("../static/audio-core.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

(async () => {
  const text = ("Here is a short explanation. " +
    "The disk is full, so first remove files you no longer need. " +
    "Then empty the recycle bin and check the available space again. ").repeat(7);
  const pieces = speechSegments(text);
  assert.ok(pieces.length > 2);
  assert.ok(pieces[0].length <= 180 && pieces.slice(1).every(part => part.length <= 360));
  assert.equal(pieces.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
  assert.deepEqual(speechSegments(""), []);

  const events = [];
  const firstPlayback = deferred();
  const queue = playSpeechQueue(["first", "second"], {
    prepare: async value => { events.push(`prepare ${value}`); return value; },
    play: value => {
      events.push(`play ${value}`);
      return value === "first" ? firstPlayback.promise : Promise.resolve({ finishedNormally: true, seconds: 2 });
    },
    cancelled: () => false,
    onPlayed: value => events.push(`finished ${value.seconds}`)
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["prepare first", "play first", "prepare second"],
    "prepare the next segment while the first plays");
  firstPlayback.resolve({ finishedNormally: true, seconds: 1 });
  assert.equal(await queue, true);
  assert.deepEqual(events, ["prepare first", "play first", "prepare second", "finished 1", "play second", "finished 2"]);

  let interrupted = false;
  const playback = deferred(), prefetch = deferred(), heard = [];
  const interruptedQueue = playSpeechQueue(["first", "second"], {
    prepare: value => value === "first" ? Promise.resolve(value) : prefetch.promise,
    play: value => { heard.push(value); return playback.promise; },
    cancelled: () => interrupted,
    onPlayed: () => { throw new Error("An interrupted segment must not be marked complete."); }
  });
  await new Promise(resolve => setImmediate(resolve));
  interrupted = true;
  playback.resolve({ finishedNormally: false, seconds: 0 });
  assert.equal(await interruptedQueue, false);
  prefetch.reject(new Error("cancelled prefetch"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(heard, ["first"], "do not play a prefetched segment after interruption");

  await assert.rejects(playSpeechQueue(["first"], {
    prepare: () => Promise.reject(new Error("speech unavailable")),
    play: () => { throw new Error("must not play"); },
    cancelled: () => false,
    onPlayed: () => {}
  }), /speech unavailable/);
  console.log("Speech queue and interruption tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });

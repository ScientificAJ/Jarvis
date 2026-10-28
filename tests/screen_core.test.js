const assert = require("node:assert/strict");
const { difference, sourceSignature, ScreenTimeline, framesForRequest, previousFramesForRequest } = require("../static/screen-core.js");

function image(value) { return new Uint8Array(48).fill(value); }
assert.equal(difference(image(0), image(0)).score, 0);
assert.ok(difference(image(0), image(255)).score > 0.9);
assert.notEqual(sourceSignature("Display 1", "monitor", 1920, 1080), sourceSignature("Display 2", "monitor", 1920, 1080));
assert.notEqual(sourceSignature("Display 1", "monitor", 1920, 1080), sourceSignature("Display 1", "window", 1920, 1080));

// A long spoken turn that crosses several screens retains the beginning,
// latest frame and earlier distinct screens in chronological order.
{
  const timeline = new ScreenTimeline(1000, 1, { maxCandidates: 8 });
  for (let i = 0; i < 20; i++) {
    const frame = { time: 1000 + i * 2000, fingerprint: image((i % 4) * 60), image: `frame-${i}` };
    if (timeline.shouldKeep(frame.fingerprint, frame.time, i === 0 || i === 19)) timeline.add(frame);
  }
  assert.ok(timeline.frames.length <= 8, "memory must remain bounded");
  assert.equal(timeline.frames[0].image, "frame-0");
  assert.equal(timeline.frames[timeline.frames.length - 1].image, "frame-19");
  const selected = timeline.select(6);
  assert.equal(selected[0].image, "frame-0");
  assert.equal(selected[selected.length - 1].image, "frame-19");
  assert.ok(selected.every((frame, index) => index === 0 || frame.time >= selected[index - 1].time));
  assert.ok(new Set(selected.map(frame => frame.fingerprint[0])).size >= 3, "retain different screens");
}

// Follow-up context is limited to the same chat and active sharing session.
{
  const previous = { version: 3, chatId: "chat-a", sentAt: 5000,
    frames: [{ image: "old", time: 2000 }, { image: "new", time: 4000 }] };
  const current = { startedAt: 7000, frames: [{ time: 6800 }] };
  const frames = previousFramesForRequest(previous, current, 3, true, 8000, "chat-a");
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(frame => frame.phase), ["previous", "previous"]);
  assert.ok(frames.every(frame => frame.offset_seconds < 0));
  assert.deepEqual(previousFramesForRequest(previous, current, 4, true, 8000, "chat-a"), []);
  assert.deepEqual(previousFramesForRequest(previous, current, 3, false, 8000, "chat-a"), []);
  assert.deepEqual(previousFramesForRequest(previous, current, 3, true, 8000, "chat-b"), []);
  assert.deepEqual(previousFramesForRequest(previous, current, 3, true, 605001, "chat-a"), []);
}

// Turning sharing off or replacing its stream invalidates earlier screenshots.
{
  const snapshot = { version: 3, startedAt: 1000, frames: [{ image: "frame", time: 2500, phase: "during" }] };
  assert.deepEqual(framesForRequest(snapshot, 4, true, 4000), []);
  assert.deepEqual(framesForRequest(snapshot, 3, false, 4000), []);
  assert.deepEqual(framesForRequest(snapshot, 3, true, 4000), [
    { image: "frame", age_seconds: 1.5, offset_seconds: 1.5, phase: "during" }
  ]);
}

// Duplicate images can be skipped but regular coverage is retained for a long turn.
{
  const timeline = new ScreenTimeline(0, 1);
  timeline.add({ time: 0, fingerprint: image(20), image: "start" });
  assert.equal(timeline.shouldKeep(image(20), 1000), false);
  assert.equal(timeline.shouldKeep(image(20), 10000), true);
  assert.equal(timeline.shouldKeep(image(20), 1001, true), true);
}

// A small but meaningful new screen region should not be treated as a duplicate.
{
  const base = new Uint8Array(64 * 36 * 3);
  const changed = base.slice();
  changed.fill(255, 0, 30 * 3);
  const timeline = new ScreenTimeline(0, 1);
  timeline.add({ time: 0, fingerprint: base, image: "before" });
  assert.equal(timeline.shouldKeep(changed, 800), true);
}
console.log("Screen timeline tests passed.");

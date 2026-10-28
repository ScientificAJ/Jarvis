const assert = require("node:assert/strict");
const { PendingTranscription } = require("../static/audio-core.js");

(async () => {
  const pending = new PendingTranscription();
  let resolveFirst;
  pending.add(new Promise(resolve => { resolveFirst = resolve; }));
  const oldResult = pending.collect();
  pending.resume();
  pending.add(Promise.resolve("continued"));
  const completeResult = pending.collect();
  resolveFirst("original");
  assert.equal(await oldResult, null, "a resumed request must not submit prematurely");
  assert.deepEqual(await completeResult, ["original", "continued"], "keep the original and continuation in order");
  console.log("Turn continuation test passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });

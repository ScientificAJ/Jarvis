const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
let Processor;
let message;
class BaseProcessor {
  constructor() { this.port = { postMessage: value => { message = value; } }; }
}
const context = { AudioWorkletProcessor: BaseProcessor, Float32Array, registerProcessor: (name, cls) => { Processor = cls; } };
vm.runInNewContext(fs.readFileSync(require.resolve("../static/audio-worklet.js"), "utf8"), context);
const processor = new Processor();
for (let i = 0; i < 32; i++) processor.process([[new Float32Array(128).fill(0.2)], [new Float32Array(128).fill(0.4)]]);
assert.equal(message.microphone.length, 4096);
assert.equal(message.reference.length, 4096);
assert.ok(Math.abs(message.microphone[1024] - 0.2) < 0.0001);
assert.ok(Math.abs(message.reference[1024] - 0.4) < 0.0001);
console.log("Audio worklet reference test passed.");

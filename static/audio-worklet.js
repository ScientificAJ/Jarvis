class JarvisMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.reference = new Float32Array(4096);
    this.used = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const reference = inputs[1] && inputs[1][0];
    let offset = 0;
    while (offset < channel.length) {
      const length = Math.min(channel.length - offset, this.buffer.length - this.used);
      this.buffer.set(channel.subarray(offset, offset + length), this.used);
      if (reference) this.reference.set(reference.subarray(offset, offset + length), this.used);
      this.used += length;
      offset += length;
      if (this.used === this.buffer.length) {
        this.port.postMessage({ microphone: this.buffer, reference: this.reference }, [this.buffer.buffer, this.reference.buffer]);
        this.buffer = new Float32Array(4096);
        this.reference = new Float32Array(4096);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor("jarvis-microphone", JarvisMicrophone);

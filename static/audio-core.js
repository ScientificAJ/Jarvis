/* Detect speech and feed its audio to the local streaming recognizer. */
(function (root) {
  "use strict";

  class SpeechSegmenter {
    constructor(options) {
      this.sampleRate = options.sampleRate;
      this.limit = Math.round(this.sampleRate * 0.25);
      this.silenceLimit = Math.round(this.sampleRate * (options.silenceSeconds || 2));
      this.threshold = options.threshold || 0.009;
      this.preLimit = Math.round(this.sampleRate * 0.15);
      this.onStart = options.onStart || (() => {});
      this.onVoice = options.onVoice || (() => {});
      this.onAudio = options.onAudio;
      this.onFinish = options.onFinish;
      this.reset();
    }

    reset() {
      this.speaking = false;
      this.pre = [];
      this.preCount = 0;
      this.silentCount = 0;
      this.parts = [];
      this.count = 0;
    }

    addPart(block) {
      if (block.length) {
        this.parts.push(block);
        this.count += block.length;
      }
    }

    take(count) {
      const result = new Float32Array(count);
      let offset = 0;
      while (offset < count) {
        const first = this.parts[0];
        const amount = Math.min(first.length, count - offset);
        result.set(first.subarray(0, amount), offset);
        offset += amount;
        this.count -= amount;
        if (amount === first.length) this.parts.shift();
        else this.parts[0] = first.subarray(amount);
      }
      return result;
    }

    flushFull() {
      while (this.count >= this.limit) this.onAudio(this.take(this.limit));
    }

    remember(block) {
      this.pre.push(block);
      this.preCount += block.length;
      while (this.preCount > this.preLimit && this.pre.length) {
        const excess = this.preCount - this.preLimit;
        const first = this.pre[0];
        if (first.length <= excess) {
          this.pre.shift();
          this.preCount -= first.length;
        } else {
          this.pre[0] = first.subarray(excess);
          this.preCount -= excess;
        }
      }
    }

    finish() {
      if (!this.speaking) return;
      if (this.count) this.onAudio(this.take(this.count));
      this.reset();
      this.onFinish();
    }

    push(block) {
      if (!block || !block.length) return;
      let energy = 0;
      for (let i = 0; i < block.length; i++) energy += block[i] * block[i];
      const voiced = Math.sqrt(energy / block.length) >= this.threshold;

      if (!this.speaking) {
        if (!voiced) {
          this.remember(block);
          return;
        }
        this.speaking = true;
        this.onStart();
        this.onVoice();
        for (const p of this.pre) this.addPart(p);
        this.pre = [];
        this.preCount = 0;
        this.addPart(block);
        this.flushFull();
        return;
      }

      this.addPart(block);
      this.flushFull();
      if (voiced) { this.onVoice(); this.silentCount = 0; }
      else {
        this.silentCount += block.length;
        if (this.silentCount >= this.silenceLimit) this.finish();
      }
    }
  }

  function rms(samples) {
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    return samples.length ? Math.sqrt(energy / samples.length) : 0;
  }

  // Browser echo cancellation is the first line of defense. This detector
  // additionally compares the microphone with a delayed playback reference;
  // a strong match is treated as speaker echo, not a user interruption.
  class InterruptionDetector {
    constructor(options) {
      this.sampleRate = options.sampleRate;
      this.threshold = options.threshold || 0.009;
      this.onInterrupt = options.onInterrupt;
      this.onCandidate = options.onCandidate || (() => {});
      this.stride = Math.max(1, Math.round(this.sampleRate / 8000));
      this.reset();
    }

    reset() {
      this.references = Array.from({ length: this.stride }, () => []);
      this.recentReference = [];
      this.pre = [];
      this.preCount = 0;
      this.attack = 0;
      this.firstCandidate = null;
      this.sequence = 0;
      this.partialCount = 0;
      this.partialMic = 0;
    }

    downsamplePair(mic, reference) {
      const microphone = [], playback = Array.from({ length: this.stride }, () => []);
      for (let i = 0; i < mic.length; i++) {
        this.partialMic += mic[i];
        this.recentReference.push(reference[i]);
        if (this.recentReference.length > this.stride * 2) this.recentReference.shift();
        this.partialCount++;
        if (this.partialCount === this.stride) {
          microphone.push(this.partialMic / this.stride);
          // Keep every sample phase so arbitrary speaker/microphone delays do
          // not disappear when 48 kHz input is reduced for comparison.
          for (let phase = 0; phase < this.stride; phase++) {
            let sum = 0;
            const start = this.recentReference.length - this.stride - phase;
            for (let j = 0; j < this.stride; j++) if (start + j >= 0) sum += this.recentReference[start + j];
            playback[phase].push(sum / this.stride);
          }
          this.partialMic = this.partialCount = 0;
        }
      }
      return { microphone, playback };
    }

    echoSimilarity(current) {
      const start = this.references[0].length - current.length;
      if (start < 0 || !current.length) return 0;
      let micPower = 0;
      for (let i = 0; i < current.length; i += 12) micPower += current[i] * current[i];
      if (micPower < 1e-8) return 0;
      const maxLag = Math.min(start, Math.round(0.6 * this.sampleRate / this.stride));
      let best = 0;
      for (const reference of this.references) {
        for (let lag = 0; lag <= maxLag; lag++) {
          let dot = 0, referencePower = 0;
          for (let i = 0; i < current.length; i += 12) {
            const value = reference[start + i - lag];
            dot += current[i] * value;
            referencePower += value * value;
          }
          if (referencePower > 1e-8) {
            const similarity = Math.abs(dot) / Math.sqrt(micPower * referencePower);
            if (similarity > best) best = similarity;
            if (best >= 0.9) return best;
          }
        }
      }
      return best;
    }

    push(mic, reference, playbackActive) {
      if (!mic || !mic.length) return;
      const ref = reference && reference.length === mic.length ? reference : new Float32Array(mic.length);
      const reduced = this.downsamplePair(mic, ref);
      const refLimit = Math.ceil(this.sampleRate / this.stride * 1.0);
      for (let phase = 0; phase < this.stride; phase++) {
        this.references[phase].push(...reduced.playback[phase]);
        if (this.references[phase].length > refLimit) this.references[phase] = this.references[phase].slice(-refLimit);
      }
      const level = rms(mic);
      const gate = Math.max(this.threshold * 1.5, playbackActive ? rms(ref) * 0.04 : 0);
      const echo = playbackActive && level >= gate && this.echoSimilarity(reduced.microphone) >= 0.82;
      const voice = level >= gate && !echo;
      const entry = { sequence: this.sequence++, samples: mic, echo };
      this.pre.push(entry);
      this.preCount += mic.length;
      const preLimit = this.sampleRate * 0.8;
      while (this.pre.length && this.preCount > preLimit) this.preCount -= this.pre.shift().samples.length;
      if (voice) {
        if (this.attack <= 0 || this.firstCandidate === null) {
          this.firstCandidate = entry.sequence;
          this.onCandidate();
        }
        this.attack += mic.length;
      } else {
        this.attack = Math.max(0, this.attack - mic.length * 0.5);
        if (!this.attack) this.firstCandidate = null;
      }
      if (this.attack >= this.sampleRate * 0.20 && this.firstCandidate !== null) {
        const first = this.firstCandidate;
        const blocks = this.pre.filter(item => item.sequence >= first || (item.sequence === first - 1 && !item.echo))
          .map(item => item.samples);
        this.reset();
        this.onInterrupt(blocks);
      }
    }
  }

  // Send ordered microphone packets as they are captured. Each utterance has
  // its own stateful server-side decoder, not independent batch transcripts.
  class StreamingTranscription {
    constructor(options) {
      this.id = options.id;
      this.rate = options.sampleRate;
      this.send = options.send;
      this.finalize = options.finalize;
      this.cancelRemote = options.cancel;
      this.onPartial = options.onPartial || (() => {});
      this.onError = options.onError || (() => {});
      this.tail = Promise.resolve();
      this.sequence = 0;
      this.pendingSamples = 0;
      this.error = null;
      this.closed = false;
      this.cancelled = false;
      this.done = false;
      this.remoteCancelled = false;
      this.finishPromise = null;
    }

    forgetRemote() {
      if (this.remoteCancelled) return;
      this.remoteCancelled = true;
      try { Promise.resolve(this.cancelRemote(this.id)).catch(() => {}); } catch (_) {}
    }

    push(samples) {
      if (this.closed || this.error || !samples.length) return;
      if (this.pendingSamples + samples.length > this.rate * 30) {
        this.error = new Error("Speech recognition cannot keep up. Try closing other applications.");
        this.onError(this.error);
        this.forgetRemote();
        return;
      }
      const bytes = pcm16Bytes(samples);
      const sequence = this.sequence++;
      this.pendingSamples += samples.length;
      this.tail = this.tail.then(async () => {
        if (this.cancelled || this.error) return;
        const value = await this.send(this.id, this.rate, sequence, bytes);
        if (!this.cancelled && value && typeof value.text === "string") this.onPartial(value.text);
      }).catch(error => {
        if (!this.cancelled && !this.error) { this.error = error; this.onError(error); }
      }).finally(() => { this.pendingSamples -= samples.length; });
    }

    finish() {
      if (this.finishPromise) return this.finishPromise;
      this.closed = true;
      this.finishPromise = this.tail.then(async () => {
        if (this.cancelled) {
          const error = new Error("Transcription cancelled.");
          error.name = "AbortError";
          return { error };
        }
        if (this.error) { this.forgetRemote(); return { error: this.error }; }
        if (!this.sequence) return { text: "" };
        try {
          const result = await this.finalize(this.id, this.sequence);
          this.done = true;
          return { text: typeof result.text === "string" ? result.text : "" };
        } catch (error) {
          this.forgetRemote();
          return { error };
        }
      });
      return this.finishPromise;
    }

    cancel() {
      if (this.cancelled || this.done) return;
      this.cancelled = true;
      this.closed = true;
      this.forgetRemote();
    }
  }

  // Keep completed streaming segments if the user resumes while the final
  // transcript is being assembled.
  class PendingTranscription {
    constructor() { this.tasks = []; this.revision = 0; }
    add(task) { this.tasks.push(task); }
    resume() { this.revision++; }
    async collect() {
      const revision = ++this.revision;
      const results = await Promise.all(this.tasks.slice());
      return revision === this.revision ? results : null;
    }
  }

  function pcm16Bytes(samples) {
    const bytes = new ArrayBuffer(samples.length * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    return bytes;
  }

  // Start speech with a short natural phrase, then prepare longer phrases
  // while the previous audio is playing. Preserve every word in order.
  function speechSegments(text) {
    let remaining = String(text || "").trim();
    const segments = [];
    while (remaining) {
      const limit = segments.length ? 360 : 180;
      if (remaining.length <= limit) { segments.push(remaining); break; }
      const window = remaining.slice(0, limit);
      let cut = 0;
      const endings = /[.!?](?=\s|$)/g;
      let match;
      while ((match = endings.exec(window))) if (match.index >= 30) cut = match.index + 1;
      if (!cut) {
        const lastSpace = window.search(/\s+\S*$/);
        cut = lastSpace > 0 ? lastSpace : limit;
      }
      const segment = remaining.slice(0, cut).trim();
      if (segment) segments.push(segment);
      remaining = remaining.slice(cut).trimStart();
    }
    return segments;
  }

  async function playSpeechQueue(segments, { prepare, play, cancelled, onPlayed }) {
    if (!segments.length) return true;
    // Handle prefetch errors immediately so stopping playback does not leave an
    // unhandled rejected promise for the next segment.
    const safePrepare = segment => Promise.resolve().then(() => prepare(segment))
      .then(blob => ({ blob }), error => ({ error }));
    let pending = safePrepare(segments[0]);
    for (let index = 0; index < segments.length; index++) {
      const prepared = await pending;
      if (cancelled()) return false;
      if (prepared.error) throw prepared.error;
      pending = index + 1 < segments.length ? safePrepare(segments[index + 1]) : null;
      const played = await play(prepared.blob);
      if (cancelled() || !played.finishedNormally) return false;
      onPlayed(played);
    }
    return true;
  }

  const api = { SpeechSegmenter, InterruptionDetector, StreamingTranscription, PendingTranscription,
    pcm16Bytes, speechSegments, playSpeechQueue, rms };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.JarvisAudio = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

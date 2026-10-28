/* Keep bounded, time-ordered screen samples spanning a spoken request. */
(function (root) {
  "use strict";

  function difference(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return { mean: 1, changed: 1, score: 1 };
    let total = 0, changed = 0;
    for (let i = 0; i < a.length; i += 3) {
      const delta = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
      total += delta;
      if (delta >= 20) changed++;
    }
    const pixels = a.length / 3;
    const mean = total / (pixels * 255);
    const fraction = changed / pixels;
    return { mean, changed: fraction, score: Math.min(1, mean * 2 + fraction * 0.7) };
  }

  function sourceSignature(label, surface, width, height) {
    return JSON.stringify([label || "", surface || "", Number(width) || 0, Number(height) || 0]);
  }

  class ScreenTimeline {
    constructor(startedAt, version, options = {}) {
      this.startedAt = startedAt;
      this.version = version;
      this.maxCandidates = options.maxCandidates || 24;
      this.frames = [];
      this.samples = 0;
      this.changes = 0;
      this.lastVoiceAt = startedAt;
      this.endedAt = startedAt;
    }

    noteVoice(time) { this.lastVoiceAt = Math.max(this.lastVoiceAt, time); }

    shouldKeep(fingerprint, time, force = false) {
      this.samples++;
      const previous = this.frames[this.frames.length - 1];
      if (!previous) return true;
      const delta = difference(previous.fingerprint, fingerprint);
      // Small error banners and changing text can occupy only a small part
      // of a display, so don't require a whole-screen scene change.
      const changed = delta.mean >= 0.004 || delta.changed >= 0.008;
      if (changed) this.changes++;
      return force || changed || time - previous.time >= 10000;
    }

    add(frame) {
      this.frames.push(frame);
      while (this.frames.length > this.maxCandidates) {
        let remove = 1, lowest = Infinity;
        const span = Math.max(1, this.frames[this.frames.length - 1].time - this.frames[0].time);
        for (let i = 1; i < this.frames.length - 1; i++) {
          const before = this.frames[i - 1], candidate = this.frames[i], after = this.frames[i + 1];
          const novelty = Math.min(difference(before.fingerprint, candidate.fingerprint).score,
                                   difference(candidate.fingerprint, after.fingerprint).score);
          const isolation = Math.min(candidate.time - before.time, after.time - candidate.time) / span;
          const score = novelty + 2 * isolation;
          if (score < lowest) { lowest = score; remove = i; }
        }
        this.frames.splice(remove, 1);
      }
    }

    select(limit = 6) {
      if (this.frames.length <= limit) return this.frames.slice();
      const chosen = new Set([0, this.frames.length - 1]);
      const span = Math.max(1, this.frames[this.frames.length - 1].time - this.frames[0].time);
      while (chosen.size < limit) {
        let bestIndex = -1, bestScore = -Infinity;
        for (let i = 1; i < this.frames.length - 1; i++) {
          if (chosen.has(i)) continue;
          const frame = this.frames[i];
          let timeGap = Infinity, visualGap = Infinity;
          for (const index of chosen) {
            timeGap = Math.min(timeGap, Math.abs(frame.time - this.frames[index].time));
            visualGap = Math.min(visualGap, difference(frame.fingerprint, this.frames[index].fingerprint).score);
          }
          const score = 0.55 * Math.min(1, timeGap / (span / Math.max(1, limit - 1))) + 0.45 * visualGap;
          if (score > bestScore) { bestScore = score; bestIndex = i; }
        }
        if (bestIndex < 0) break;
        chosen.add(bestIndex);
      }
      return [...chosen].sort((a, b) => a - b).map(index => this.frames[index]);
    }
  }

  function framesForRequest(snapshot, currentVersion, sharing, now) {
    if (!snapshot || !sharing || snapshot.version !== currentVersion) return [];
    return snapshot.frames.map(frame => ({
      image: frame.image,
      age_seconds: Math.min(86400, Math.max(0, (now - frame.time) / 1000)),
      offset_seconds: Math.max(-10, Math.min(86400, (frame.time - snapshot.startedAt) / 1000)),
      phase: frame.phase
    }));
  }

  function previousFramesForRequest(previous, current, currentVersion, sharing, now, chatId) {
    if (!previous || !current || !sharing || previous.version !== currentVersion ||
        previous.chatId !== chatId || now - previous.sentAt > 600000) return [];
    const earliestCurrent = current.frames.length ? Math.min(...current.frames.map(frame => frame.time)) : current.startedAt;
    const candidates = previous.frames.filter(frame => frame.time <= Math.min(current.startedAt, earliestCurrent));
    if (!candidates.length) return [];
    const selected = candidates.length === 1 ? candidates : [candidates[0], candidates[candidates.length - 1]];
    return selected.map(frame => ({
      image: frame.image,
      age_seconds: Math.min(86400, Math.max(0, (now - frame.time) / 1000)),
      offset_seconds: Math.max(-86400, Math.min(0, (frame.time - current.startedAt) / 1000)),
      phase: "previous"
    }));
  }

  const api = { difference, sourceSignature, ScreenTimeline, framesForRequest, previousFramesForRequest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.JarvisScreen = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

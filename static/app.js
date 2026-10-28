(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const ui = {
    status: $("status"), orb: $("orb"), start: $("start-button"), mic: $("mic-button"),
    screen: $("screen-button"), interrupt: $("interrupt-button"), preview: $("screen-preview"),
    screenCard: $("screen-card"), messages: $("messages"), textForm: $("text-form"),
    textInput: $("text-input"), send: $("send-button"), settings: $("settings-dialog"),
    settingsForm: $("settings-form"), profile: $("profile"), voice: $("voice"),
    sensitivity: $("sensitivity"), history: $("history-dialog"),
    historyList: $("history-list"), replay: $("replay-button")
  };
  const SETTINGS = "jarvis.settings.v1";
  const CHATS = "jarvis.chats.v1";
  const SELECTED = "jarvis.selected.v1";
  const defaults = { profile: "", voice: "", sensitivity: "0.009" };

  function readStored(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch (_) { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }
  function newId() {
    return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  let settings = { ...defaults, ...readStored(SETTINGS, {}) };
  let chats = readStored(CHATS, []);
  if (!Array.isArray(chats)) chats = [];
  chats = chats.filter(c => c && typeof c.id === "string" && Array.isArray(c.messages));
  let selectedId = readStored(SELECTED, "");
  let chat = chats.find(c => c.id === selectedId) || chats[0] || { id: newId(), messages: [] };

  const state = {
    active: false, starting: false, model: "loading", environmentKey: false, phase: "idle",
    generation: 0, aborter: null, utterance: null, micStream: null, displayStream: null,
    audioContext: null, source: null, worklet: null, silenceGain: null, segmenter: null, detector: null,
    audio: null, audioUrl: null, playbackSource: null, playbackMessage: null, playbackOffset: 0, finishPlayback: null,
    echoGraceUntil: 0, frameTimer: null, screenVersion: 0, screenSignature: null, lastTimelineProbeAt: 0, interruptionFrame: null,
    previousScreen: null,
    statusText: "Preparing the local speech model...", statusError: false
  };

  function saveChats() {
    if (chat.messages.length && !chats.some(c => c.id === chat.id)) chats.unshift(chat);
    store(CHATS, chats);
    store(SELECTED, chat.id);
  }

  function status(message, error = false) {
    state.statusText = message;
    state.statusError = error;
    ui.status.textContent = message;
    ui.status.classList.toggle("error", error);
  }

  function readyText() {
    if (state.active && state.micStream) return "Listening. Speak whenever you're ready.";
    if (state.active) return "Microphone is off. You can turn it on or type a message.";
    if (state.model === "loading") return "Preparing the local speech model...";
    if (state.model === "error") return "The local speech model could not load. See the command window.";
    return "Ready when you are.";
  }

  function renderControls() {
    ui.start.textContent = state.starting ? "Starting..." : state.active ? "Stop Jarvis" : "Start Jarvis";
    ui.start.disabled = state.starting || (!state.active && state.model !== "ready");
    ui.mic.disabled = !state.active || state.starting;
    ui.screen.disabled = !state.active || state.starting;
    ui.mic.setAttribute("aria-pressed", String(Boolean(state.micStream)));
    ui.screen.setAttribute("aria-pressed", String(Boolean(state.displayStream)));
    ui.mic.textContent = state.micStream ? "Microphone on" : "Microphone off";
    ui.screen.textContent = state.displayStream ? "Screen on" : "Screen off";
    ui.interrupt.hidden = !["transcribing", "thinking", "speaking"].includes(state.phase);
    ui.send.disabled = state.phase !== "idle" && state.phase !== "listening";
    ui.orb.classList.toggle("active", state.active || state.phase === "thinking" || state.phase === "speaking");
    ui.replay.hidden = !chat.messages.some(m => m.role === "assistant");
  }

  function setPhase(phase, message) {
    state.phase = phase;
    if (message) status(message);
    renderControls();
  }

  function renderMessages() {
    ui.messages.replaceChildren();
    if (!chat.messages.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Your conversation will appear here.";
      ui.messages.append(empty);
    }
    for (const message of chat.messages) {
      if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") continue;
      const item = document.createElement("div");
      item.className = `message ${message.role}`;
      const label = document.createElement("span");
      label.className = "who";
      label.textContent = message.role === "user" ? "YOU" : message.interrupted ? "JARVIS · INTERRUPTED" : "JARVIS";
      const body = document.createElement("div");
      body.textContent = message.content;
      item.append(label, body);
      ui.messages.append(item);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
    renderControls();
  }

  function appendMessage(role, content) {
    const message = { role, content };
    chat.messages.push(message);
    chat.updated = Date.now();
    saveChats();
    renderMessages();
    return message;
  }

  async function request(path, options = {}) {
    const timeoutMs = path === "/api/transcribe" ? 180000 :
      path === "/api/chat" ? 90000 : path === "/api/speech" ? 60000 : 10000;
    const controller = new AbortController();
    const parent = options.signal;
    const cancel = () => controller.abort();
    if (parent?.aborted) cancel();
    else parent?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(path, { ...options, signal: controller.signal });
      if (!response.ok) {
        let message = `Request failed (${response.status}).`;
        try { message = (await response.json()).error || message; } catch (_) {}
        throw new Error(message);
      }
      return response;
    } catch (error) {
      if (timedOut) {
        if (path === "/api/transcribe") throw new Error("Local transcription took too long. Close other memory-heavy apps and try again.");
        if (path === "/api/chat") throw new Error("The answer service took too long. Please try again.");
        if (path === "/api/speech") throw new Error("The speech service took too long. You can read the answer or try Speak last answer.");
        throw new Error("The local server took too long to respond.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    }
  }

  function apiHeaders() {
    return { "Content-Type": "application/json" };
  }

  function requireKey() {
    if (state.environmentKey) return true;
    status("Restart Jarvis and enter your OpenRouter API key at startup.", true);
    return false;
  }

  function invalidateTurn() {
    if (state.phase === "speaking" && state.playbackMessage) {
      state.playbackMessage.interrupted = true;
      state.playbackMessage.spoken_seconds = Math.max(0, Math.min(86400, state.playbackOffset + (state.audio?.currentTime || 0)));
      saveChats();
      renderMessages();
    }
    state.generation++;
    if (state.aborter) state.aborter.abort();
    state.aborter = null;
    state.utterance = null;
    if (state.segmenter) state.segmenter.reset();
    if (state.detector) state.detector.reset();
    if (state.playbackSource) { state.playbackSource.disconnect(); state.playbackSource = null; }
    state.playbackMessage = null;
    state.playbackOffset = 0;
    state.echoGraceUntil = 0;
    if (state.audio) {
      state.audio.pause();
      state.audio.removeAttribute("src");
      state.audio.load();
      state.audio = null;
    }
    if (state.finishPlayback) { state.finishPlayback(); state.finishPlayback = null; }
    if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
  }

  function resumeListening(message) {
    setPhase(state.active ? "listening" : "idle", message || readyText());
  }

  // Use a monotonic clock for frame ordering and audio timing, even if the
  // computer's wall clock is adjusted during a long conversation.
  const now = () => performance.now();

  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = 64;
  thumbCanvas.height = 36;
  const imageCanvas = document.createElement("canvas");

  function captureFrame(turn = null, force = false, phase = "during") {
    if (!state.displayStream || ui.preview.readyState < 2 || !ui.preview.videoWidth || !ui.preview.videoHeight) return null;
    try {
      const track = state.displayStream.getVideoTracks()[0];
      const details = track && typeof track.getSettings === "function" ? track.getSettings() : {};
      const signature = JarvisScreen.sourceSignature(track?.label, details.displaySurface,
        details.width || ui.preview.videoWidth, details.height || ui.preview.videoHeight);
      if (state.screenSignature && state.screenSignature !== signature) {
        // Browsers may switch the shared surface without ending its track.
        // Treat a detectable source change as a new privacy boundary.
        state.screenVersion++;
        state.previousScreen = null;
        state.interruptionFrame = null;
        if (state.utterance) {
          state.utterance.screenInterrupted = true;
          state.utterance.timeline = null;
        }
      }
      state.screenSignature = signature;
      const time = now();
      const small = thumbCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
      small.drawImage(ui.preview, 0, 0, thumbCanvas.width, thumbCanvas.height);
      const rgba = small.getImageData(0, 0, thumbCanvas.width, thumbCanvas.height).data;
      const fingerprint = new Uint8Array(thumbCanvas.width * thumbCanvas.height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) {
        fingerprint[j++] = rgba[i]; fingerprint[j++] = rgba[i + 1]; fingerprint[j++] = rgba[i + 2];
      }
      if (turn && (!turn.timeline || turn.timeline.version !== state.screenVersion)) {
        turn.timeline = new JarvisScreen.ScreenTimeline(turn.startedAt, state.screenVersion);
      }
      if (turn && !turn.timeline.shouldKeep(fingerprint, time, force)) return null;
      let scale = Math.min(1, 1920 / Math.max(ui.preview.videoWidth, ui.preview.videoHeight));
      let image = "";
      // Bound each image so six frames plus the conversation fit in one request.
      for (let attempt = 0; attempt < 5; attempt++) {
        imageCanvas.width = Math.max(1, Math.round(ui.preview.videoWidth * scale));
        imageCanvas.height = Math.max(1, Math.round(ui.preview.videoHeight * scale));
        imageCanvas.getContext("2d", { alpha: false }).drawImage(ui.preview, 0, 0, imageCanvas.width, imageCanvas.height);
        image = imageCanvas.toDataURL("image/jpeg", attempt === 0 ? 0.82 : 0.65);
        if (image.length <= 1100000) break;
        scale *= 0.75;
      }
      if (!image || image.length > 1100000) return null;
      return { image, fingerprint, time, phase };
    } catch (_) { return null; }
  }

  function recordFrame(force = false, phase = "during", turn = state.utterance) {
    const frame = captureFrame(turn, force, phase);
    if (frame && turn) turn.timeline.add(frame);
    state.lastTimelineProbeAt = now();
  }

  function snapshotFrames(turn = null) {
    if (!state.displayStream) return { frames: [], version: state.screenVersion, startedAt: now(), summary: {} };
    const target = turn || { startedAt: now(), timeline: null, screenInterrupted: false };
    recordFrame(true, turn ? "after" : "during", target);
    const timeline = target.timeline;
    if (!timeline) return { frames: [], version: state.screenVersion, startedAt: target.startedAt, summary: {} };
    timeline.endedAt = now();
    return {
      frames: timeline.select(6), version: timeline.version, startedAt: target.startedAt,
      summary: { duration_seconds: Math.min(86400, Math.max(0, (timeline.endedAt - target.startedAt) / 1000)),
                 samples: timeline.samples, changes: Math.min(timeline.changes, timeline.samples),
                 partial: Boolean(target.screenInterrupted) }
    };
  }

  function stopScreen() {
    state.screenVersion++;
    if (state.frameTimer) clearInterval(state.frameTimer);
    state.frameTimer = null;
    const stream = state.displayStream;
    state.displayStream = null;
    state.screenSignature = null;
    state.interruptionFrame = null;
    state.previousScreen = null;
    if (stream && state.utterance) {
      state.utterance.screenInterrupted = true;
      state.utterance.timeline = null;
    }
    if (stream) stream.getTracks().forEach(track => track.stop());
    ui.preview.srcObject = null;
    ui.screenCard.hidden = true;
    renderControls();
  }

  function requestScreen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error("Screen sharing is not supported by this browser."));
    }
    // This call must happen directly in a click handler, before any await.
    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor", frameRate: { ideal: 5, max: 10 } },
      audio: false, monitorTypeSurfaces: "include", surfaceSwitching: "include", preferCurrentTab: false
    });
  }

  async function attachScreen(promise, generation) {
    const stream = await promise;
    if (generation !== state.generation || !state.active) {
      stream.getTracks().forEach(track => track.stop());
      return false;
    }
    stopScreen();
    state.displayStream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener("ended", () => {
      if (state.displayStream === stream) {
        stopScreen();
        status("Screen sharing stopped. You can turn it on again.");
      }
    });
    ui.preview.srcObject = stream;
    ui.screenCard.hidden = false;
    try { await ui.preview.play(); } catch (_) {}
    state.frameTimer = setInterval(() => {
      if (state.utterance && state.phase === "listening") {
        const timeline = state.utterance.timeline;
        const phase = timeline && now() - timeline.lastVoiceAt > 250 ? "after" : "during";
        recordFrame(false, phase, state.utterance);
      }
    }, 4000);
    if (state.utterance) recordFrame(true, "during", state.utterance);
    renderControls();
    return true;
  }

  async function enableScreen() {
    const generation = state.generation;
    try {
      const promise = requestScreen();
      await attachScreen(promise, generation);
      if (generation === state.generation) status(screenChoiceMessage() || "Screen sharing is on.");
    } catch (error) {
      status(error.name === "NotAllowedError" || error.name === "AbortError" ?
        "Screen sharing was not enabled. You can turn it on whenever you like." : error.message, true);
    }
  }

  function screenChoiceMessage() {
    const track = state.displayStream?.getVideoTracks()[0];
    const surface = track && typeof track.getSettings === "function" ? track.getSettings().displaySurface : "";
    return surface && surface !== "monitor" ? "A window or tab is shared. Choose Entire Screen for the whole display." : "";
  }

  function stopMic(finalize = false) {
    if (state.segmenter && finalize && state.phase === "listening") state.segmenter.finish();
    else if (state.segmenter) state.segmenter.reset();
    if (state.playbackSource && state.worklet) {
      try { state.playbackSource.disconnect(state.worklet); } catch (_) {}
    }
    if (state.worklet) { state.worklet.port.onmessage = null; state.worklet.disconnect(); }
    if (state.source) state.source.disconnect();
    if (state.silenceGain) state.silenceGain.disconnect();
    state.worklet = state.source = state.silenceGain = null;
    const stream = state.micStream;
    state.micStream = null;
    if (stream) stream.getTracks().forEach(track => track.stop());
    state.segmenter = null;
    state.detector = null;
    renderControls();
  }

  function beginUtterance() {
    if (state.utterance && state.utterance.generation === state.generation) {
      status("Listening...");
      return;
    }
    const aborter = new AbortController();
    state.aborter = aborter;
    state.utterance = { generation: state.generation, aborter, pending: new JarvisAudio.PendingTranscription(),
                        startedAt: now(), nextListeningHintAt: now() + 20000,
                        timeline: null, screenInterrupted: !state.displayStream };
    const before = state.interruptionFrame;
    state.interruptionFrame = null;
    if (before && state.displayStream && before.version === state.screenVersion && now() - before.time <= 1200) {
      state.utterance.timeline = new JarvisScreen.ScreenTimeline(state.utterance.startedAt, state.screenVersion);
      state.utterance.timeline.samples++;
      state.utterance.timeline.add(before);
    }
    recordFrame(true, "during", state.utterance);
    status("Listening...");
  }

  function noteVoice() {
    if (state.utterance && state.utterance.timeline) {
      const timeline = state.utterance.timeline;
      timeline.noteVoice(now());
      // A short pause is part of the same request if speech resumes.
      for (const frame of timeline.frames) if (frame.phase === "after") frame.phase = "during";
    }
  }

  function submitAudio(samples, rate) {
    const utterance = state.utterance;
    if (!utterance) return;
    const wav = JarvisAudio.wavBytes(samples, rate);
    const task = request("/api/transcribe", {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, signal: utterance.aborter.signal
    }).then(response => response.json()).then(value => ({ text: value.text || "" }), error => ({ error }));
    utterance.pending.add(task);
    if (state.phase === "listening") status("Listening and transcribing in the background...");
  }

  async function finishUtterance() {
    const utterance = state.utterance;
    if (!utterance || !utterance.pending.tasks.length) return;
    const waiting = utterance.pending.collect();
    const frames = snapshotFrames(utterance);
    setPhase("transcribing", "Finishing local transcription...");
    const slowTimer = setTimeout(() => {
      if (state.phase === "transcribing" && state.utterance === utterance) {
        status("Still transcribing on this computer. Close other memory-heavy apps if this is slow.");
      }
    }, 12000);
    let chunks;
    try { chunks = await waiting; }
    finally { clearTimeout(slowTimer); }
    if (!chunks || utterance.generation !== state.generation || state.utterance !== utterance) return;
    state.utterance = null;
    const failed = chunks.find(chunk => chunk.error);
    if (failed) {
      if (failed.error.name !== "AbortError") {
        resumeListening();
        status(`Transcription failed: ${failed.error.message}`, true);
      }
      return;
    }
    const transcript = chunks.map(chunk => chunk.text.trim()).filter(Boolean).join(" ");
    if (!transcript) {
      resumeListening("I couldn't make out any speech. Please try again.");
      return;
    }
    await runTurn(transcript, frames, utterance.generation, utterance.aborter);
  }

  function voiceInterruption(blocks) {
    if (!state.active || !state.segmenter) return;
    if (state.phase === "transcribing" && state.utterance) {
      // The user resumed before the pending local transcription finished.
      // Keep the earlier chunks and join the continuation into the same turn.
      state.utterance.pending.resume();
      if (state.utterance.timeline) {
        for (const frame of state.utterance.timeline.frames) frame.phase = "during";
      }
      const candidate = state.interruptionFrame;
      state.interruptionFrame = null;
      if (candidate && state.displayStream && candidate.version === state.screenVersion && now() - candidate.time <= 1200) {
        if (!state.utterance.timeline) state.utterance.timeline = new JarvisScreen.ScreenTimeline(state.utterance.startedAt, state.screenVersion);
        candidate.phase = "during";
        state.utterance.timeline.samples++;
        state.utterance.timeline.add(candidate);
      }
      state.segmenter.reset();
      setPhase("listening", "Listening to your continuation...");
    } else {
      invalidateTurn();
      setPhase("listening", "Listening to your correction...");
    }
    state.echoGraceUntil = 0;
    for (const block of blocks) state.segmenter.push(block);
  }

  function connectPlaybackReference() {
    if (!state.audio || !state.audioContext) return;
    try {
      if (!state.playbackSource) {
        state.playbackSource = state.audioContext.createMediaElementSource(state.audio);
        state.playbackSource.connect(state.audioContext.destination);
      }
      if (state.worklet) state.playbackSource.connect(state.worklet, 0, 1);
    } catch (_) {
      // Speech still plays normally when a browser cannot route the reference.
    }
  }

  async function enableMic(generation) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone access is not supported by this browser.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1
    }, video: false });
    if (generation !== state.generation || !state.active) { stream.getTracks().forEach(t => t.stop()); return; }
    try {
      const context = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
      state.audioContext = context;
      await context.audioWorklet.addModule("/audio-worklet.js");
      await context.resume();
      if (generation !== state.generation || !state.active) { stream.getTracks().forEach(t => t.stop()); return; }
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "jarvis-microphone", {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1]
      });
      const gain = context.createGain();
      gain.gain.value = 0;
      const segmenter = new JarvisAudio.SpeechSegmenter({
        sampleRate: context.sampleRate,
        silenceSeconds: 2,
        threshold: Number(settings.sensitivity) || 0.009,
        onStart: beginUtterance,
        onVoice: noteVoice,
        onChunk: samples => submitAudio(samples, context.sampleRate),
        onFinish: finishUtterance
      });
      const detector = new JarvisAudio.InterruptionDetector({
        sampleRate: context.sampleRate, threshold: Number(settings.sensitivity) || 0.009,
        onCandidate: () => {
          const frame = captureFrame(null, true, "before");
          if (frame) state.interruptionFrame = { ...frame, version: state.screenVersion };
        },
        onInterrupt: voiceInterruption
      });
      state.micStream = stream;
      state.source = source;
      state.worklet = node;
      state.silenceGain = gain;
      state.segmenter = segmenter;
      state.detector = detector;
      node.port.onmessage = event => {
        if (!state.active || state.segmenter !== segmenter) return;
        const mic = event.data.microphone;
        const reference = event.data.reference;
        if (state.phase === "listening" && now() >= state.echoGraceUntil) {
          if (state.echoGraceUntil) { detector.reset(); state.echoGraceUntil = 0; }
          segmenter.push(mic);
          if (state.phase === "listening" && state.utterance && now() >= state.utterance.nextListeningHintAt) {
            status("Still listening. If you've finished, lower microphone sensitivity or mute to send.");
            state.utterance.nextListeningHintAt = now() + 20000;
          }
          if (state.phase === "listening" && state.utterance && now() - state.lastTimelineProbeAt >= 800) {
            const timeline = state.utterance.timeline;
            const phase = timeline && now() - timeline.lastVoiceAt > 250 ? "after" : "during";
            recordFrame(false, phase, state.utterance);
          }
        } else if (["listening", "transcribing", "thinking", "speaking"].includes(state.phase)) {
          detector.push(mic, reference, Boolean(state.audio) || now() < state.echoGraceUntil);
        }
      };
      source.connect(node, 0, 0);
      node.connect(gain);
      gain.connect(context.destination);
      connectPlaybackReference();
      const track = stream.getAudioTracks()[0];
      if (track) track.addEventListener("ended", () => {
        if (state.micStream === stream) {
          stopMic(true);
          status("Microphone access ended. You can turn it on again.", true);
        }
      });
      renderControls();
    } catch (error) {
      stream.getTracks().forEach(t => t.stop());
      throw error;
    }
  }

  async function startAgent() {
    if (!requireKey()) return;
    if (!navigator.mediaDevices) { status("This browser does not support microphone and screen capture.", true); return; }
    invalidateTurn();
    state.active = true;
    state.starting = true;
    const generation = state.generation;
    setPhase("idle", "Choose Entire Screen in the browser picker, then allow your microphone.");
    // Both the audio context and display request are initiated in the click gesture.
    try {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      state.audioContext.resume().catch(() => {});
    } catch (_) {}
    let displayPromise;
    try { displayPromise = requestScreen(); }
    catch (error) { displayPromise = Promise.reject(error); }
    let screenIssue = "";
    try { await attachScreen(displayPromise, generation); }
    catch (_) { screenIssue = "Screen sharing is off. "; }
    if (state.displayStream && screenChoiceMessage()) screenIssue = screenChoiceMessage() + " ";
    if (generation !== state.generation || !state.active) return;
    let micIssue = "";
    try { await enableMic(generation); }
    catch (error) { micIssue = `Microphone unavailable: ${error.message}. `; }
    if (generation !== state.generation || !state.active) return;
    state.starting = false;
    resumeListening(screenIssue + micIssue + readyText());
  }

  function stopAgent() {
    invalidateTurn();
    state.active = false;
    state.starting = false;
    stopMic(false);
    stopScreen();
    if (state.audioContext) state.audioContext.close().catch(() => {});
    state.audioContext = null;
    resumeListening("Jarvis is paused.");
  }

  function speechText(text) {
    return text.replace(/```[\s\S]*?```/g, " Code is shown in the conversation. ")
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/[*_`~]/g, "")
      .replace(/^\s*[-+]\s+/gm, "")
      .trim();
  }

  async function playSpeechSegment(blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.audioUrl = url;
    state.audio = audio;
    connectPlaybackReference();
    const playbackSource = state.playbackSource;
    status(state.micStream ? "Speaking. You can interrupt me." : "Speaking...");
    let finishThisPlayback = null;
    let finishedNormally = false;
    try {
      await new Promise((resolve, reject) => {
        finishThisPlayback = resolve;
        state.finishPlayback = finishThisPlayback;
        audio.onended = () => { finishedNormally = true; resolve(); };
        audio.onerror = () => reject(new Error("The browser could not play the audio."));
        audio.play().catch(() => reject(new Error("The browser blocked audio playback. Use 'Speak last answer' to try again.")));
      });
    } finally {
      if (state.audio === audio) {
        state.audio = null;
        if (state.playbackSource === playbackSource && playbackSource) {
          playbackSource.disconnect();
          state.playbackSource = null;
        }
        if (finishedNormally && state.active && state.micStream) state.echoGraceUntil = now() + 450;
      }
      if (state.audioUrl === url) { URL.revokeObjectURL(url); state.audioUrl = null; }
      if (state.finishPlayback === finishThisPlayback) state.finishPlayback = null;
    }
    return { finishedNormally, seconds: Number.isFinite(audio.currentTime) ? audio.currentTime : 0 };
  }

  async function speak(text, generation, aborter, message) {
    const segments = JarvisAudio.speechSegments(speechText(text).slice(0, 30000));
    if (!segments.length) return;
    state.playbackMessage = message;
    state.playbackOffset = 0;
    if (state.detector) state.detector.reset();
    setPhase("speaking", "Preparing the spoken response...");
    const prepare = segment => request("/api/speech", {
      method: "POST", headers: apiHeaders(), signal: aborter.signal,
      body: JSON.stringify({ text: segment, voice: settings.voice })
    }).then(response => response.blob());
    let completed = false;
    try {
      completed = await JarvisAudio.playSpeechQueue(segments, {
        prepare, play: playSpeechSegment,
        cancelled: () => generation !== state.generation || aborter.signal.aborted,
        onPlayed: played => { state.playbackOffset += played.seconds; }
      });
    } finally {
      if (generation === state.generation) {
        state.playbackMessage = null;
        if (completed && message && message.interrupted) {
          delete message.interrupted;
          delete message.spoken_seconds;
          saveChats();
          renderMessages();
        }
      }
    }
  }

  async function runTurn(text, screen, generation, aborter) {
    const previous = [];
    let remainingHistory = 120000;
    for (const m of chat.messages.slice(-60).reverse()) {
      if (remainingHistory <= 0) break;
      let content = m.content;
      const budget = Math.min(49970, remainingHistory);
      if (content.length > budget) content = "[Earlier text omitted]\n" + content.slice(-budget);
      previous.unshift({ role: m.role, content,
        ...(m.interrupted ? { interrupted: true, spoken_seconds: m.spoken_seconds ?? 0 } : {}) });
      remainingHistory -= Math.min(content.length, remainingHistory);
    }
    appendMessage("user", text);
    setPhase("thinking", "Considering your request...");
    const at = now();
    const sharing = Boolean(state.displayStream);
    const currentFrames = JarvisScreen.framesForRequest(screen, state.screenVersion, sharing, at);
    const priorFrames = JarvisScreen.previousFramesForRequest(state.previousScreen, screen, state.screenVersion, sharing, at, chat.id);
    const frames = [...priorFrames, ...currentFrames];
    const screenContext = { ...(screen.summary || {}), previous_frames: priorFrames.length };
    state.previousScreen = currentFrames.length ? { version: state.screenVersion, frames: screen.frames,
      sentAt: at, chatId: chat.id } : null;
    try {
      const result = await request("/api/chat", {
        method: "POST", headers: apiHeaders(), signal: aborter.signal,
        body: JSON.stringify({ text, history: previous, profile: settings.profile, frames, screen_context: screenContext })
      });
      const answer = (await result.json()).text;
      if (generation !== state.generation) return;
      const message = appendMessage("assistant", answer);
      try { await speak(answer, generation, aborter, message); }
      catch (error) {
        if (generation !== state.generation || error.name === "AbortError") return;
        resumeListening();
        status(`The answer is ready, but speech failed: ${error.message}`, true);
        return;
      }
      if (generation === state.generation) resumeListening();
    } catch (error) {
      if (generation !== state.generation || error.name === "AbortError") return;
      resumeListening();
      status(`I couldn't complete that request: ${error.message}`, true);
    }
  }

  function fillSettings() {
    ui.profile.value = settings.profile || "";
    ui.voice.value = settings.voice || "";
    ui.sensitivity.value = settings.sensitivity || "0.009";
  }

  function renderHistory() {
    ui.historyList.replaceChildren();
    const visible = [...chats].filter(c => c.messages.length).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Your saved conversations will appear here.";
      ui.historyList.append(empty);
      return;
    }
    for (const item of visible) {
      const row = document.createElement("div");
      row.className = "history-item";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = (item.messages.find(m => m.role === "user")?.content || "Conversation").slice(0, 90);
      open.addEventListener("click", () => {
        invalidateTurn();
        state.previousScreen = null;
        chat = item;
        store(SELECTED, chat.id);
        ui.history.close();
        renderMessages();
        resumeListening();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-chat";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete ${open.textContent}`);
      remove.addEventListener("click", () => {
        if (!confirm("Delete this conversation from this browser?")) return;
        chats = chats.filter(c => c.id !== item.id);
        store(CHATS, chats);
        if (chat.id === item.id) {
          invalidateTurn();
          state.previousScreen = null;
          chat = { id: newId(), messages: [] };
          store(SELECTED, chat.id);
          renderMessages();
          resumeListening();
        }
        renderHistory();
      });
      row.append(open, remove);
      ui.historyList.append(row);
    }
  }

  ui.start.addEventListener("click", () => state.active ? stopAgent() : startAgent());
  ui.mic.addEventListener("click", async () => {
    if (state.micStream) {
      stopMic(true);
      if (state.phase === "listening") status("Microphone muted.");
    } else {
      try {
        await enableMic(state.generation);
        status("Microphone is on.");
      } catch (error) { status(`Microphone unavailable: ${error.message}`, true); }
    }
  });
  ui.screen.addEventListener("click", () => {
    if (state.displayStream) { stopScreen(); status("Screen sharing is off."); }
    else enableScreen();
  });
  ui.interrupt.addEventListener("click", () => { invalidateTurn(); resumeListening("Response stopped."); });
  $("new-button").addEventListener("click", () => {
    invalidateTurn();
    state.previousScreen = null;
    chat = { id: newId(), messages: [] };
    store(SELECTED, chat.id);
    renderMessages();
    resumeListening("New conversation. " + readyText());
  });
  $("history-button").addEventListener("click", () => { renderHistory(); ui.history.showModal(); });
  $("settings-button").addEventListener("click", () => { fillSettings(); ui.settings.showModal(); });
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  ui.settingsForm.addEventListener("submit", event => {
    event.preventDefault();
    settings = { profile: ui.profile.value.trim(), voice: ui.voice.value.trim(), sensitivity: ui.sensitivity.value };
    const saved = store(SETTINGS, settings);
    if (state.segmenter) state.segmenter.threshold = Number(settings.sensitivity);
    if (state.detector) state.detector.threshold = Number(settings.sensitivity);
    ui.settings.close();
    status(saved ? "Settings saved. " + readyText() : "Settings are available for this session, but the browser could not save them.", !saved);
  });
  ui.textInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); ui.textForm.requestSubmit(); }
  });
  ui.textForm.addEventListener("submit", event => {
    event.preventDefault();
    const text = ui.textInput.value.trim();
    if (!text || !requireKey() || !["idle", "listening"].includes(state.phase)) return;
    invalidateTurn();
    const aborter = new AbortController();
    state.aborter = aborter;
    ui.textInput.value = "";
    runTurn(text, snapshotFrames(), state.generation, aborter);
  });
  ui.replay.addEventListener("click", async () => {
    const last = [...chat.messages].reverse().find(m => m.role === "assistant");
    if (!last || !requireKey()) return;
    invalidateTurn();
    const aborter = new AbortController();
    state.aborter = aborter;
    const generation = state.generation;
    try {
      await speak(last.content, generation, aborter, last);
      if (generation === state.generation) resumeListening();
    } catch (error) {
      if (generation === state.generation && error.name !== "AbortError") {
        resumeListening();
        status(`Speech failed: ${error.message}`, true);
      }
    }
  });

  async function pollModel() {
    try {
      const response = await request("/api/status");
      const value = await response.json();
      const changed = state.model !== value.model;
      state.model = value.model;
      state.environmentKey = value.key_from_environment;
      if (changed && !state.active && state.phase === "idle") status(value.detail, value.model === "error");
      renderControls();
      if (value.model === "loading") setTimeout(pollModel, 2000);
    } catch (_) {
      status("The local server is unavailable. Start Jarvis again.", true);
      setTimeout(pollModel, 5000);
    }
  }

  renderMessages();
  renderControls();
  pollModel();
})();

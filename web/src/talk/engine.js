// Talk-page audio/WS engine — behavior ported VERBATIM from the battle-tested
// voice-standup MVP (public/talk.html). Do not "simplify" the audio path:
// every quirk here answers a real bug seen on real devices.
//
// Key invariants:
// - Never force the AudioContext to 24k. Some devices (iOS Safari, mobile
//   Chromium) ignore a requested sample rate; audio tagged 24k that is really
//   48k plays back as garbled fast-forward upstream. Capture at the device's
//   native rate and downsample precisely on the client.
// - 48k -> 24k is exact 2:1 pair-averaging (built-in low-pass). Any other
//   rate uses linear interpolation with a cross-packet phase (dsPos) so
//   packet boundaries do not crack, clamped >= 0 after each packet.
// - Playback schedules 24k PCM AudioBuffers back to back (nextPlayTime) and
//   tracks the currently playing item (curItemId/itemStartAt/itemSchedMs) so
//   that on barge-in we can tell the model the REAL played milliseconds via
//   conversation.item.truncate, then flush all live sources.

const WORKLET =
  "class Cap extends AudioWorkletProcessor{process(inputs){const ch=inputs[0][0];if(ch)this.port.postMessage(ch.slice(0));return true}}registerProcessor('cap',Cap)";

/**
 * Resolve API base + member token from the page URL.
 * Production: served at <prefix>/u/<token> -> base = <prefix>.
 * Dev (vite): /talk.html?token=<token> -> base = '' (vite proxy handles /api, /ws).
 */
export function resolveTokenAndBase() {
  const m = location.pathname.match(/^(.*)\/u\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { base: m[1], token: m[2] };
  return { base: '', token: new URLSearchParams(location.search).get('token') || '' };
}

export class TalkEngine {
  /**
   * @param {{base: string, token: string, on: {
   *   connecting: () => void,
   *   ready: () => void,
   *   error: (message: string) => void,
   *   speechStarted: () => void,
   *   aiAudio: () => void,
   *   aiDelta: (text: string) => void,
   *   aiDone: () => void,
   *   userText: (text: string) => void,
   *   responseDone: () => void,
   *   saved: (summary: object) => void,
   *   closed: () => void,
   * }}} opts
   */
  constructor({ base, token, on, errorFallback }) {
    this.base = base;
    this.token = token;
    this.on = on;
    this.errorFallback = errorFallback || '服务出错';
    this.ws = null;
    this.ctx = null;
    this.micStream = null;
    this.workletNode = null;
    this.analyser = null;
    this.done = false;
    this.muted = false;
    this.textMode = false;
    // playback scheduling state
    this.nextPlayTime = 0;
    this.liveSources = [];
    this.curItemId = null;
    this.itemStartAt = 0;
    this.itemSchedMs = 0;
    // cross-packet resample phase
    this.dsPos = 0;
    // stale-socket watchdog (half-open mobile connections receive nothing
    // but never fire onclose; the server heartbeats every 20s)
    this.lastMsgAt = 0;
    this.watchdog = null;
  }

  /** Acquire mic + audio graph, then open the relay WS. Throws if mic denied. */
  async start() {
    // Device-native sample rate — never force 24k (see header comment).
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    const SRC_RATE = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));

    // Visualization tap (parallel branch, does not touch the capture path).
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;

    this.workletNode = new AudioWorkletNode(this.ctx, 'cap');

    let buf = [];
    const CHUNK_SRC = Math.round(SRC_RATE / 10); // ship a packet every ~100ms
    this.workletNode.port.onmessage = (e) => {
      buf.push(e.data);
      if (buf.reduce((n, a) => n + a.length, 0) >= CHUNK_SRC) {
        const flat = new Float32Array(buf.reduce((n, a) => n + a.length, 0));
        let o = 0;
        for (const a of buf) {
          flat.set(a, o);
          o += a.length;
        }
        buf = [];
        if (this.ws && this.ws.readyState === 1 && !this.muted && !this.textMode) {
          const pcm = this.downsampleTo24k(flat, SRC_RATE);
          const i16 = new Int16Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, pcm[i] * 32767));
          let bin = '';
          const u8 = new Uint8Array(i16.buffer);
          for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
          this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
        }
      }
    };
    await this.acquireMic();
    this.connect();
  }

  /**
   * (Re-)acquire the mic and wire it into the persistent audio graph.
   * Separate from start() because text mode fully releases the device (an
   * open capture track blocks the phone keyboard's own voice dictation) and
   * switching back to voice has to grab it again.
   */
  async acquireMic() {
    if (this.micStream) return;
    // mobile browsers may suspend the context while no capture track is live
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.dsPos = 0; // fresh capture stream — restart the resample phase
    this.micSrc = this.ctx.createMediaStreamSource(this.micStream);
    this.micSrc.connect(this.analyser);
    this.micSrc.connect(this.workletNode);
  }

  releaseMic() {
    if (this.micSrc) {
      try {
        this.micSrc.disconnect();
      } catch {
        /* already disconnected */
      }
      this.micSrc = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // carry the mode so a text-mode reconnect greets silently in text
    const mode = this.textMode ? '&mode=text' : '';
    this.ws = new WebSocket(`${proto}://${location.host}${this.base}/ws?token=${this.token}${mode}`);
    this.on.connecting();
    this.lastMsgAt = Date.now();
    if (!this.watchdog) {
      // With the server heartbeating every 20s, 45s of silence means the
      // socket is dead (half-open) — close it so the reconnect flow runs
      // instead of the user typing/talking into a black hole.
      this.watchdog = setInterval(() => {
        if (this.done) return;
        if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastMsgAt > 45000) {
          try {
            this.ws.close();
          } catch {
            /* already closing */
          }
        }
      }, 10000);
    }
    this.ws.onclose = () => {
      if (!this.done) this.on.closed();
    };
    // onerror is always followed by onclose — let closed() drive reconnection
    // instead of flashing a competing error status.
    this.ws.onerror = () => {};
    this.ws.onmessage = (e) => {
      let ev;
      this.lastMsgAt = Date.now();
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (ev.type) {
        case 'app.ready':
          this.on.ready();
          // Device diagnostic beacon (server logs it to debug capture issues).
          this.send({ type: 'app.client_info', ua: navigator.userAgent, ctx_rate: this.ctx ? this.ctx.sampleRate : null });
          break;
        case 'app.error':
          this.on.error(ev.message || this.errorFallback);
          break;
        case 'input_audio_buffer.speech_started':
          if (this.curItemId && this.nextPlayTime > this.ctx.currentTime) {
            // AI audio barged in on: report how far playback REALLY got.
            const played = Math.max(0, Math.min(this.itemSchedMs, (this.ctx.currentTime - this.itemStartAt) * 1000));
            this.send({
              type: 'conversation.item.truncate',
              item_id: this.curItemId,
              content_index: 0,
              audio_end_ms: Math.round(played),
            });
          }
          this.curItemId = null;
          this.flushPlayback();
          this.on.speechStarted();
          break;
        case 'response.output_audio.delta':
          this.playDelta(ev);
          this.on.aiAudio();
          break;
        case 'response.output_audio_transcript.delta':
          this.on.aiDelta(ev.delta);
          break;
        case 'response.output_audio_transcript.done':
          this.on.aiDone();
          break;
        // text-mode replies stream as plain text deltas
        case 'response.output_text.delta':
        case 'response.text.delta':
          this.on.aiDelta(ev.delta);
          break;
        case 'response.output_text.done':
        case 'response.text.done':
          this.on.aiDone();
          break;
        // User item appears (in true order) before the reply starts — let the
        // app reserve a bubble; the async ASR text fills it in later. Typed
        // messages carry their text up front and render immediately.
        case 'conversation.item.added':
        case 'conversation.item.created':
          if (ev.item?.type === 'message' && ev.item?.role === 'user') {
            const typed = (ev.item.content || []).find((c) => c.type === 'input_text')?.text;
            if (typed) this.on.userText(typed, ev.item.id);
            else this.on.userPending(ev.item.id);
          }
          break;
        case 'conversation.item.input_audio_transcription.completed':
          this.on.userText((ev.transcript || '').trim(), ev.item_id);
          break;
        case 'conversation.item.input_audio_transcription.failed':
          this.on.userText('', ev.item_id); // drop the reserved bubble
          break;
        case 'response.done':
          this.on.responseDone();
          break;
        case 'error':
          this.on.error(ev.error?.message || this.errorFallback);
          break;
        case 'app.saved':
          this.done = true;
          this.on.saved(ev.summary);
          // Let Luna say goodbye, then tear down.
          setTimeout(() => this.destroy(), 15000);
          break;
      }
    };
  }

  /**
   * Re-open the relay WS after a drop, keeping mic + audio graph alive. The
   * server starts a fresh upstream session but feeds it the archived
   * transcript, so the conversation continues instead of restarting.
   */
  /**
   * Mute: Luna hears nothing until unmute, but keeps talking — only the mic
   * side is gated (frames dropped before send, capture keeps running so
   * unmute is instant). The buffer clear drops any half-captured utterance
   * so a muted-mid-sentence fragment can't be transcribed later.
   */
  mute() {
    if (this.muted || this.done) return;
    this.muted = true;
    this.send({ type: 'input_audio_buffer.clear' });
  }

  unmute() {
    this.muted = false;
  }

  /**
   * Switch reply modality mid-call. Text mode fully releases the mic device
   * (not just gating the feed — a held capture track blocks phone-keyboard
   * voice dictation) and silences any in-flight audio; voice mode re-acquires
   * it. Throws if the re-acquire is denied — caller keeps text mode then.
   */
  async setMode(mode) {
    if (this.done) return;
    this.textMode = mode === 'text';
    if (this.textMode) {
      // Entering text mode lifts mute: the typed channel must never feel
      // gated, and a stale mute would only resurface as a surprise later.
      this.muted = false;
      this.flushPlayback();
      this.curItemId = null;
      this.releaseMic();
    } else {
      try {
        await this.acquireMic();
      } catch (err) {
        this.textMode = true;
        throw err;
      }
    }
    this.send({ type: 'app.set_mode', mode: this.textMode ? 'text' : 'voice' });
  }

  /**
   * Send a typed message (text mode). Returns false when the socket is not
   * open — the caller must keep the draft and surface the failure instead of
   * letting the message vanish silently.
   */
  sendText(text) {
    const t = (text || '').trim();
    if (!t || this.done) return false;
    const sent = this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] },
    });
    if (!sent) return false;
    this.send({ type: 'response.create' });
    return true;
  }

  reconnect() {
    if (this.done) return;
    // this.muted survives reconnect on purpose: the user muted for privacy;
    // a network blip must never silently hot-mic them again.
    try {
      if (this.ws) {
        this.ws.onclose = null; // silence the stale socket — closed() belongs to the new one
        this.ws.close();
      }
    } catch {
      /* already closed */
    }
    this.flushPlayback();
    this.curItemId = null;
    this.connect();
  }

  /** User pressed 结束并提交. */
  end() {
    this.send({ type: 'app.end' });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  playDelta(ev) {
    // a straggler delta after destroy() must not throw on the closed context
    if (!this.ctx || this.ctx.state === 'closed') return;
    const bin = atob(ev.delta);
    const dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    const n = bin.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
    const buf = this.ctx.createBuffer(1, n, 24000);
    buf.getChannelData(0).set(f32);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime + 0.05, this.nextPlayTime);
    if (ev.item_id && ev.item_id !== this.curItemId) {
      this.curItemId = ev.item_id;
      this.itemStartAt = t;
      this.itemSchedMs = 0;
    }
    s.start(t);
    this.nextPlayTime = t + buf.duration;
    this.itemSchedMs += buf.duration * 1000;
    this.liveSources.push(s);
    s.onended = () => {
      this.liveSources = this.liveSources.filter((x) => x !== s);
    };
  }

  flushPlayback() {
    for (const s of this.liveSources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.liveSources = [];
    this.nextPlayTime = 0;
  }

  downsampleTo24k(f32, srcRate) {
    if (srcRate === 24000) return f32;
    if (srcRate === 48000) {
      // exact 2:1 — pair-averaging doubles as a low-pass
      const n = f32.length >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = (f32[2 * i] + f32[2 * i + 1]) * 0.5;
      return out;
    }
    const ratio = srcRate / 24000;
    const out = [];
    for (; this.dsPos < f32.length - 1; this.dsPos += ratio) {
      const i = Math.floor(this.dsPos);
      const frac = this.dsPos - i;
      out.push(f32[i] * (1 - frac) + f32[i + 1] * frac);
    }
    this.dsPos = Math.max(0, this.dsPos - f32.length);
    return Float32Array.from(out);
  }

  destroy() {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    // Teardown must go silent immediately: stop every scheduled audio source
    // (a deliberate pause while Luna is mid-sentence would otherwise keep
    // playing the queued buffers) and close the AudioContext so nothing can
    // sound after this point and the audio device is released.
    this.flushPlayback();
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* noop */
    }
    try {
      this.releaseMic();
    } catch {
      /* noop */
    }
    try {
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    } catch {
      /* already closed */
    }
  }
}

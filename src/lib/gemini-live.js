/**
 * Gemini Live upstream adapter.
 *
 * Presents the same surface the relay uses on the OpenAI Realtime WebSocket
 * (send / on / close / readyState) but speaks Google's BidiGenerateContent
 * protocol upstream, translating both directions:
 *
 *   relay -> upstream: session.update -> setup; input_audio_buffer.append ->
 *   realtimeInput.audio (24k resampled to 16k, phase-continuous);
 *   conversation.item.create[input_text] -> clientContent user turn;
 *   conversation.item.create[function_call_output] -> toolResponse;
 *   first bare response.create -> greeting kick; response.create with
 *   instructions -> clientContent nudge; cancel/commit/clear/truncate -> no-op
 *   (Gemini VAD and barge-in are automatic).
 *
 *   upstream -> relay: setupComplete -> session.updated; modelTurn audio
 *   (24k out, passthrough) -> response.output_audio.delta;
 *   outputTranscription -> response.output_audio_transcript.delta/.done
 *   (response.output_text.* in text mode); inputTranscription -> synthetic
 *   conversation.item.added slot + input_audio_transcription.completed
 *   (native — no ASR sidecar); toolCall -> response.done with function_call
 *   items; turnComplete -> response.done; interrupted ->
 *   input_audio_buffer.speech_started (client stops playback).
 *
 * Text mode: Gemini cannot switch responseModalities mid-session, so the
 * adapter keeps the audio session and gates modality itself — audio parts are
 * dropped and the output transcription streams as text deltas.
 */

import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const GEMINI_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];

const GREETING_KICK = '（同事已接通，请按你的流程直接开口，不要提到这条消息）';

// 15-tap windowed-sinc low-pass (cutoff ~7.2kHz at 24k input) applied before
// the 24k→16k decimation — bare linear interpolation aliases 8–12kHz content
// down into the speech band and audibly degrades Gemini's ASR.
const LP = (() => {
  const N = 15, fc = 0.3, h = [];
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const k = n - (N - 1) / 2;
    const s = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
    h.push(s * w);
    sum += s * w;
  }
  return h.map(v => v / sum);
})();

export class GeminiUpstream {
  /** `_socket` injects a fake upstream for unit tests. */
  constructor({ wsUrl, key, model, proxy, _socket }) {
    this.handlers = { open: [], message: [], error: [], close: [] };
    this.mode = 'voice';
    this.greeted = false;
    this.pendingCalls = new Map(); // call id -> name (for toolResponse)
    // synthetic item/turn ids
    this.userSeq = 0;
    this.aiSeq = 0;
    this.userItemId = null;   // open user slot awaiting end-of-turn
    this.userBuf = '';        // accumulated input transcription
    this.aiItemId = null;     // current model turn (audio grouping for client playback)
    this.aiBuf = '';          // accumulated output transcription
    this.lastUsage = null;
    // 24k -> 16k resample state (phase-continuous across packets)
    this.rsPos = 0;
    this.rsTail = null;
    this.lpHist = null; // last LP.length-1 raw samples for filter continuity
    const m = model.startsWith('models/') ? model : `models/${model}`;
    this.model = m;
    this.ws = _socket || new WebSocket(`${wsUrl}?key=${encodeURIComponent(key)}`, {
      agent: proxy && wsUrl.startsWith('wss:') ? new HttpsProxyAgent(proxy) : undefined,
    });
    this.ws.on('open', () => this.emit('open'));
    this.ws.on('error', e => this.emit('error', e));
    this.ws.on('close', (code, reason) => {
      if (this.lastUsage) {
        const u = this.lastUsage;
        console.log(`[rounds] gemini usage total=${u.totalTokenCount ?? '?'} prompt=${u.promptTokenCount ?? '?'} response=${u.responseTokenCount ?? '?'}`);
      }
      if (code && code !== 1000 && code !== 1005) console.error(`[rounds] gemini close ${code} ${String(reason || '').slice(0, 200)}`);
      this.emit('close', code, reason);
    });
    this.ws.on('message', raw => this.upstreamMessage(raw));
  }

  get readyState() { return this.ws.readyState; }
  on(event, cb) { (this.handlers[event] ||= []).push(cb); }
  emit(event, ...args) { for (const cb of this.handlers[event] || []) cb(...args); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
  toClient(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  toGemini(obj) {
    if (process.env.GEMINI_DEBUG && !obj.realtimeInput) console.log(`[gemini-debug] >> ${Object.keys(obj).join(',')} ${JSON.stringify(obj).slice(0, 180)}`);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ---- relay -> Gemini ----

  send(raw) {
    let ev;
    try { ev = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    switch (ev.type) {
      case 'session.update': {
        const s = ev.session || {};
        // mid-call session.update only flips modality (adapter-level gate)
        if (!s.instructions) {
          if (s.output_modalities) this.mode = s.output_modalities.includes('text') ? 'text' : 'voice';
          return;
        }
        this.mode = (s.output_modalities || []).includes('text') ? 'text' : 'voice';
        const voice = GEMINI_VOICES.find(v => v.toLowerCase() === String(s.audio?.output?.voice || '').toLowerCase());
        this.toGemini({
          setup: {
            model: this.model,
            generationConfig: {
              responseModalities: ['AUDIO'],
              // thinking + tool calls in audio sessions trips a server-side
              // CONTENT_TYPE_AUDIO close (observed on native-audio-12-2025) —
              // and a voice agent shouldn't pause to think mid-call anyway
              thinkingConfig: { thinkingBudget: 0 },
              ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
            },
            systemInstruction: { parts: [{ text: s.instructions }] },
            tools: [{ functionDeclarations: (s.tools || []).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // Default VAD is far too eager for Chinese speech — it cuts
            // mid-sentence pauses into separate turns and the model answers
            // each fragment (the OpenAI side runs semantic_vad at low
            // eagerness for the same reason). Low end-sensitivity + a longer
            // silence window keeps one utterance in one turn.
            realtimeInputConfig: {
              automaticActivityDetection: {
                endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
                silenceDurationMs: 1200,
                prefixPaddingMs: 300,
              },
            },
          },
        });
        return;
      }
      case 'input_audio_buffer.append': {
        const pcm16k = this.resample24to16(Buffer.from(ev.audio || '', 'base64'));
        if (pcm16k.length) {
          this.toGemini({ realtimeInput: { audio: { data: Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
        }
        return;
      }
      case 'conversation.item.create': {
        const item = ev.item || {};
        if (item.type === 'function_call_output') {
          const name = this.pendingCalls.get(item.call_id) || 'unknown';
          this.pendingCalls.delete(item.call_id);
          let response;
          try { const p = JSON.parse(item.output); response = (p && typeof p === 'object') ? p : { result: p }; }
          catch { response = { result: String(item.output || '') }; }
          this.toGemini({ toolResponse: { functionResponses: [{ id: item.call_id, name, response }] } });
          return;
        }
        if (item.type === 'message' && item.role === 'user') {
          const text = (item.content || []).find(c => c.type === 'input_text')?.text?.trim();
          if (!text) return;
          // echo the item back (OpenAI echoes; Gemini doesn't) so the client
          // renders the bubble and the relay archives the typed line
          const id = `tu_${++this.userSeq}`;
          this.toClient({ type: 'conversation.item.added', item: { id, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
          this.toGemini({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
          return;
        }
        return;
      }
      case 'response.create': {
        const instructions = ev.response?.instructions;
        if (instructions) {
          // system-side nudge (e.g. app.end wrap-up) — not rendered, not archived
          this.toGemini({ clientContent: { turns: [{ role: 'user', parts: [{ text: `（系统指令）${instructions}` }] }], turnComplete: true } });
        } else if (!this.greeted) {
          this.greeted = true;
          this.toGemini({ clientContent: { turns: [{ role: 'user', parts: [{ text: GREETING_KICK }] }], turnComplete: true } });
        }
        // bare response.create after a tool response: Gemini continues on its own
        return;
      }
      // no Gemini equivalents — VAD, barge-in and truncation are automatic
      case 'response.cancel':
      case 'input_audio_buffer.commit':
      case 'input_audio_buffer.clear':
      case 'conversation.item.truncate':
        return;
      default:
        return;
    }
  }

  // ---- Gemini -> relay/client ----

  upstreamMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (process.env.GEMINI_DEBUG) {
      const sc = m.serverContent;
      const keys = sc ? `serverContent{${Object.keys(sc).join(',')}${sc.modelTurn ? `;parts:${(sc.modelTurn.parts || []).map(p => Object.keys(p).join('+')).join('|')}` : ''}}` : Object.keys(m).join(',');
      console.log(`[gemini-debug] << ${keys}`);
    }

    if (m.setupComplete) { this.toClient({ type: 'session.updated' }); return; }

    if (m.toolCall) {
      const calls = m.toolCall.functionCalls || [];
      for (const fc of calls) this.pendingCalls.set(fc.id, fc.name);
      this.finishUserTurn();
      this.toClient({
        type: 'response.done',
        response: { output: calls.map(fc => ({ type: 'function_call', name: fc.name, call_id: fc.id, arguments: JSON.stringify(fc.args || {}) })) },
      });
      return;
    }

    if (m.goAway) { console.log('[rounds] gemini goAway', JSON.stringify(m.goAway)); return; }
    if (m.usageMetadata) this.lastUsage = m.usageMetadata;

    const sc = m.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      this.finishAiTurn();
      this.toClient({ type: 'input_audio_buffer.speech_started' });
      return;
    }

    // member speech transcription (native) — reserve the bubble on the first
    // chunk, then stream every accumulation as an updated `completed` event
    // (client and relay both overwrite by item_id) so the subtitle grows live
    // instead of appearing only when the model replies. The slot stays open
    // until turnComplete so late-arriving chunks merge into the same line
    // rather than splitting one utterance across bubbles.
    if (sc.inputTranscription?.text) {
      if (!this.userItemId) {
        this.userItemId = `u_${++this.userSeq}`;
        this.toClient({ type: 'conversation.item.added', item: { id: this.userItemId, type: 'message', role: 'user', content: [] } });
      }
      this.userBuf += sc.inputTranscription.text;
      this.toClient({ type: 'conversation.item.input_audio_transcription.completed', item_id: this.userItemId, transcript: this.userBuf.trim() });
    }

    if (sc.outputTranscription?.text) {
      this.aiBuf += sc.outputTranscription.text;
      this.toClient(this.mode === 'text'
        ? { type: 'response.output_text.delta', delta: sc.outputTranscription.text }
        : { type: 'response.output_audio_transcript.delta', delta: sc.outputTranscription.text });
    }

    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) {
        if (this.mode === 'text') continue; // text mode: subtitles only
        if (!this.aiItemId) this.aiItemId = `a_${++this.aiSeq}`;
        this.toClient({ type: 'response.output_audio.delta', delta: p.inlineData.data, item_id: this.aiItemId });
      }
    }

    if (sc.turnComplete || sc.generationComplete) {
      this.finishAiTurn();
      if (sc.turnComplete) {
        this.finishUserTurn();
        this.toClient({ type: 'response.done', response: { output: [] } });
      }
    }
  }

  /** Close the open user slot (text was already streamed progressively). */
  finishUserTurn() {
    this.userItemId = null;
    this.userBuf = '';
  }

  /** Close the open model turn: emit the accumulated transcript as done. */
  finishAiTurn() {
    if (this.aiBuf.trim()) {
      this.toClient(this.mode === 'text'
        ? { type: 'response.output_text.done', text: this.aiBuf.trim() }
        : { type: 'response.output_audio_transcript.done', transcript: this.aiBuf.trim() });
    }
    this.aiBuf = '';
    this.aiItemId = null;
  }

  /**
   * 24k int16 buffer -> 16k int16: anti-alias low-pass, then linear
   * interpolation with a cross-packet phase (same technique as the client's
   * downsampler) so packet boundaries do not crack. Both the filter history
   * and the interpolation phase persist across packets.
   */
  resample24to16(buf) {
    const n = buf.length >> 1;
    if (!n) return new Int16Array(0);
    const H = LP.length - 1;
    // raw stream with filter history prepended (first packet: repeat-pad to
    // avoid a zero-transient at session start)
    const raw = new Float32Array(H + n);
    if (this.lpHist) raw.set(this.lpHist, 0);
    else for (let i = 0; i < H; i++) raw[i] = buf.readInt16LE(0);
    for (let i = 0; i < n; i++) raw[H + i] = buf.readInt16LE(i * 2);
    this.lpHist = raw.slice(raw.length - H);
    // filtered[i] aligns with raw packet sample i (constant group delay)
    const filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let t = 0; t <= H; t++) acc += raw[i + t] * LP[t];
      filtered[i] = acc;
    }
    const tail = this.rsTail !== null ? 1 : 0;
    const src = new Float32Array(tail + n);
    if (tail) src[0] = this.rsTail;
    src.set(filtered, tail);
    const ratio = 1.5;
    const out = [];
    let pos = this.rsPos;
    for (; pos + 1 < src.length; pos += ratio) {
      const i = Math.floor(pos), f = pos - i;
      out.push(src[i] * (1 - f) + src[i + 1] * f);
    }
    this.rsPos = Math.max(0, pos - (src.length - 1));
    this.rsTail = src[src.length - 1];
    const i16 = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(out[i])));
    return i16;
  }
}

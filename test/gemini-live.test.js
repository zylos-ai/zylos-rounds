import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiUpstream, GEMINI_VOICES } from '../src/lib/gemini-live.js';
import { providerProtocol } from '../src/lib/settings.js';

/** Fake upstream socket capturing what the adapter sends to Gemini. */
function fakeSocket() {
  const sent = [];
  const listeners = {};
  return {
    sent,
    readyState: 1, // WebSocket.OPEN
    send(s) { sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    on(ev, cb) { (listeners[ev] ||= []).push(cb); },
    fire(ev, ...args) { for (const cb of listeners[ev] || []) cb(...args); },
  };
}

function boot() {
  const sock = fakeSocket();
  const up = new GeminiUpstream({ wsUrl: 'wss://x', key: 'k', model: 'gemini-test', _socket: sock });
  const out = [];
  up.on('message', raw => out.push(JSON.parse(raw.toString())));
  return { sock, up, out };
}

const SESSION_UPDATE = JSON.stringify({
  type: 'session.update',
  session: {
    type: 'realtime',
    output_modalities: ['audio'],
    instructions: '你是 Luna',
    tools: [{ type: 'function', name: 'submit_standup_summary', description: 'd', parameters: { type: 'object', properties: {} } }],
    audio: { input: {}, output: { voice: 'marin' } },
  },
});

test('gemini adapter: session.update becomes setup with system instruction and tools', () => {
  const { sock, up } = boot();
  up.send(SESSION_UPDATE);
  assert.equal(sock.sent.length, 1);
  const setup = sock.sent[0].setup;
  assert.equal(setup.model, 'models/gemini-test');
  assert.equal(setup.systemInstruction.parts[0].text, '你是 Luna');
  assert.equal(setup.tools[0].functionDeclarations[0].name, 'submit_standup_summary');
  assert.ok(setup.inputAudioTranscription && setup.outputAudioTranscription);
  // 'marin' is not a Gemini voice — no speechConfig forced
  assert.equal(setup.generationConfig.speechConfig, undefined);
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  // thinking must be off (thinking+tools+audio trips upstream 1007)
  assert.equal(setup.generationConfig.thinkingConfig.thinkingBudget, 0);
  // VAD must be tuned down — default end-sensitivity splits Chinese sentences
  const vad = setup.realtimeInputConfig.automaticActivityDetection;
  assert.equal(vad.endOfSpeechSensitivity, 'END_SENSITIVITY_LOW');
  assert.ok(vad.silenceDurationMs >= 1000);
});

test('gemini adapter: setupComplete -> session.updated; first response.create -> greeting kick', () => {
  const { sock, up, out } = boot();
  up.send(SESSION_UPDATE);
  sock.fire('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  assert.equal(out[0].type, 'session.updated');
  up.send(JSON.stringify({ type: 'response.create' }));
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[1].clientContent.turnComplete, true);
  // a second bare response.create must NOT kick again
  up.send(JSON.stringify({ type: 'response.create' }));
  assert.equal(sock.sent.length, 2);
  // but one with instructions goes through as a nudge
  up.send(JSON.stringify({ type: 'response.create', response: { instructions: '收尾' } }));
  assert.equal(sock.sent.length, 3);
  assert.match(sock.sent[2].clientContent.turns[0].parts[0].text, /收尾/);
});

test('gemini adapter: audio append is resampled 24k->16k phase-continuously', () => {
  const { sock, up } = boot();
  up.send(SESSION_UPDATE);
  // 300 samples of a ramp at 24k -> expect 2/3 as many out overall
  const total = 300;
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) pcm.writeInt16LE(i * 50 - 7500, i * 2);
  // send as two packets to exercise the cross-packet phase
  up.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(0, 150 * 2).toString('base64') }));
  up.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(150 * 2).toString('base64') }));
  const audioMsgs = sock.sent.filter(m => m.realtimeInput);
  assert.equal(audioMsgs.length, 2);
  const outSamples = audioMsgs.reduce((n, m) => n + Buffer.from(m.realtimeInput.audio.data, 'base64').length / 2, 0);
  assert.ok(Math.abs(outSamples - total / 1.5) <= 2, `expected ~200 samples, got ${outSamples}`);
  assert.equal(audioMsgs[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  // the resampled ramp must stay near-monotonic (small ripple from the
  // anti-alias FIR is fine; a phase crack at the packet boundary is not)
  const all = audioMsgs.flatMap(m => {
    const b = Buffer.from(m.realtimeInput.audio.data, 'base64');
    return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
  });
  for (let i = 1; i < all.length; i++) assert.ok(all[i] >= all[i - 1] - 80, `crack at ${i}: ${all[i - 1]} -> ${all[i]}`);
  assert.ok(all.at(-1) > all[0] + 5000, 'ramp did not rise');
});

test('gemini adapter: user subtitles stream progressively and merge into one slot per turn', () => {
  const { sock, up, out } = boot();
  up.send(SESSION_UPDATE);
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: '昨天写了' } } })));
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: '文档' } } })));
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { outputTranscription: { text: '好的' }, modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } })));
  // a late transcription chunk arriving mid-reply must extend the SAME slot
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: '和测试' } } })));
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { turnComplete: true } })));
  const types = out.map(e => e.type);
  assert.deepEqual(types, [
    'conversation.item.added',
    'conversation.item.input_audio_transcription.completed', // 昨天写了 (progressive)
    'conversation.item.input_audio_transcription.completed', // 昨天写了文档
    'response.output_audio_transcript.delta',
    'response.output_audio.delta',
    'conversation.item.input_audio_transcription.completed', // 昨天写了文档和测试 — same slot
    'response.output_audio_transcript.done',
    'response.done',
  ]);
  const completes = out.filter(e => e.type === 'conversation.item.input_audio_transcription.completed');
  assert.deepEqual(completes.map(e => e.transcript), ['昨天写了', '昨天写了文档', '昨天写了文档和测试']);
  assert.ok(completes.every(e => e.item_id === out[0].item.id), 'all updates target one slot');
  assert.equal(out.find(e => e.type === 'response.output_audio_transcript.done').transcript, '好的');
  // next turn opens a NEW slot
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { inputTranscription: { text: '第二句' } } })));
  const added = out.filter(e => e.type === 'conversation.item.added');
  assert.equal(added.length, 2);
  assert.notEqual(added[1].item.id, added[0].item.id);
});

test('gemini adapter: toolCall round-trips through function_call_output as toolResponse', () => {
  const { sock, up, out } = boot();
  up.send(SESSION_UPDATE);
  sock.fire('message', Buffer.from(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc1', name: 'submit_standup_summary', args: { yesterday: ['x'] } }] } })));
  const done = out.find(e => e.type === 'response.done');
  assert.equal(done.response.output[0].type, 'function_call');
  assert.equal(done.response.output[0].call_id, 'fc1');
  assert.deepEqual(JSON.parse(done.response.output[0].arguments), { yesterday: ['x'] });
  // relay answers with function_call_output -> adapter converts to toolResponse with the remembered name
  up.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'fc1', output: '{"ok":true}' } }));
  const tr = sock.sent.find(m => m.toolResponse);
  assert.equal(tr.toolResponse.functionResponses[0].id, 'fc1');
  assert.equal(tr.toolResponse.functionResponses[0].name, 'submit_standup_summary');
  assert.deepEqual(tr.toolResponse.functionResponses[0].response, { ok: true });
});

test('gemini adapter: typed text echoes to client and reaches Gemini as a turn', () => {
  const { sock, up, out } = boot();
  up.send(SESSION_UPDATE);
  up.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '我打字说' }] } }));
  const echo = out.find(e => e.type === 'conversation.item.added');
  assert.equal(echo.item.content[0].text, '我打字说');
  const turn = sock.sent.find(m => m.clientContent);
  assert.equal(turn.clientContent.turns[0].parts[0].text, '我打字说');
});

test('gemini adapter: interrupted -> speech_started; text mode drops audio, streams text', () => {
  const { sock, up, out } = boot();
  up.send(SESSION_UPDATE);
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { interrupted: true } })));
  assert.equal(out.at(-1).type, 'input_audio_buffer.speech_started');
  // flip to text mode (mid-call session.update without instructions)
  up.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['text'] } }));
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { outputTranscription: { text: '文字回复' }, modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } })));
  sock.fire('message', Buffer.from(JSON.stringify({ serverContent: { turnComplete: true } })));
  const tail = out.slice(-3).map(e => e.type);
  assert.deepEqual(tail, ['response.output_text.delta', 'response.output_text.done', 'response.done']);
  assert.ok(!out.some(e => e.type === 'response.output_audio.delta'));
});

test('providerProtocol: inferred from base_url', () => {
  assert.equal(providerProtocol({ base_url: 'https://api.openai.com' }), 'openai');
  assert.equal(providerProtocol({ base_url: 'https://generativelanguage.googleapis.com' }), 'gemini');
  assert.equal(providerProtocol(null), 'openai');
});

test('GEMINI_VOICES exported for settings surface', () => {
  assert.ok(GEMINI_VOICES.includes('Kore'));
});

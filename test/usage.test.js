import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/lib/store.js';
import { DEFAULT_PRICES, priceFor, costUsd, resolvePrices } from '../src/lib/pricing.js';
import { GeminiUpstream } from '../src/lib/gemini-live.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-test-'));
  return new Store(path.join(dir, 'test.db'));
}

function fakeSocket() {
  const listeners = {};
  return {
    sent: [],
    readyState: 1,
    send(s) { this.sent.push(JSON.parse(s)); },
    close() { this.readyState = 3; },
    on(ev, cb) { (listeners[ev] ||= []).push(cb); },
    fire(ev, ...args) { for (const cb of listeners[ev] || []) cb(...args); },
  };
}

test('priceFor: exact match, longest prefix, unknown', () => {
  assert.equal(priceFor('gpt-realtime-2.1'), DEFAULT_PRICES['gpt-realtime-2.1']);
  // dated variant inherits the family entry via prefix
  assert.equal(priceFor('gemini-2.5-flash-native-audio-preview-12-2025'), DEFAULT_PRICES['gemini-2.5-flash-native-audio']);
  assert.equal(priceFor('models/gemini-3.1-flash-live-preview'), DEFAULT_PRICES['gemini-3.1-flash-live']);
  // '-mini' must not fall back onto the non-mini prefix price
  assert.equal(priceFor('gpt-realtime-2.1-mini'), DEFAULT_PRICES['gpt-realtime-2.1-mini']);
  assert.equal(priceFor('totally-unknown'), null);
});

test('costUsd: audio + cached + asr math', () => {
  // 1 min of gemini talk: 750 audio in, 750 audio out -> ~$0.01125
  const gemini = costUsd({ model: 'gemini-3.1-flash-live-preview', input_audio: 750, output_audio: 750 });
  assert.ok(Math.abs(gemini - (750 * 3 + 750 * 12) / 1e6) < 1e-9);
  // openai with cached portion: cached audio billed at $0.4 not $32
  const openai = costUsd({
    model: 'gpt-realtime-2.1', input_audio: 1000, cached_audio: 600, output_audio: 200,
    asr_seconds: 60, asr_model: 'gpt-4o-transcribe',
  });
  const expected = (400 * 32 + 600 * 0.4 + 200 * 64) / 1e6 + 0.006;
  assert.ok(Math.abs(openai - expected) < 1e-9);
  // unknown model records at zero cost rather than guessing
  assert.equal(costUsd({ model: 'nope', input_audio: 1000 }), 0);
});

test('resolvePrices: settings override merges over defaults per model', () => {
  const s = tmpStore();
  s.setSetting('prices', JSON.stringify({ 'gpt-realtime-2.1': { audioOut: 50 }, 'new-model': { textIn: 1, textOut: 2 } }));
  const p = resolvePrices(s);
  assert.equal(p['gpt-realtime-2.1'].audioOut, 50);      // overridden
  assert.equal(p['gpt-realtime-2.1'].audioIn, 32);       // preserved from defaults
  assert.equal(p['new-model'].textIn, 1);                // new entry added
  // malformed override falls back to defaults
  s.setSetting('prices', '{broken');
  assert.equal(resolvePrices(s)['gpt-realtime-2.1'].audioOut, 64);
  s.close();
});

test('usage_log: insert + month summary rollups', () => {
  const s = tmpStore();
  const id = Number(s.addMember('王五', 'tokU').lastInsertRowid);
  s.insertUsage({ date: '2026-07-19', slot: 'voice', provider: 'gemini', model: 'gemini-3.1-flash-live-preview', member_id: id, seconds: 300, input_audio: 7000, output_audio: 4000, cost_usd: 0.069 });
  s.insertUsage({ date: '2026-07-19', slot: 'profile', provider: 'openai', model: 'gpt-5.5', member_id: id, input_text: 2000, output_text: 500, cost_usd: 0.025 });
  s.insertUsage({ date: '2026-07-01', slot: 'voice', provider: 'openai', model: 'gpt-realtime-2.1', member_id: id, seconds: 120, input_audio: 1000, output_audio: 900, asr_seconds: 55, asr_model: 'gpt-4o-transcribe', cost_usd: 0.08 });
  s.insertUsage({ date: '2026-06-30', slot: 'voice', provider: 'openai', model: 'gpt-realtime-2.1', member_id: id, seconds: 60, cost_usd: 1 }); // other month

  const sum = s.usageSummary('2026-07', '2026-07-19');
  assert.equal(sum.entries, 3);
  assert.ok(Math.abs(sum.total_usd - 0.174) < 1e-9);
  assert.ok(Math.abs(sum.today_usd - 0.094) < 1e-9);
  assert.equal(sum.by_day.length, 2);
  assert.equal(sum.by_model.length, 3);
  const voice = sum.by_model.find(r => r.model.startsWith('gemini'));
  assert.equal(voice.seconds, 300);
  assert.equal(sum.by_member.length, 1);
  assert.equal(sum.by_member[0].name, '王五');
  assert.equal(sum.by_member[0].calls, 3);
  s.close();
});

test('gemini adapter accumulates per-turn usageMetadata by modality', () => {
  const sock = fakeSocket();
  const up = new GeminiUpstream({ wsUrl: 'wss://x', key: 'k', model: 'gemini-test', _socket: sock });
  up.on('message', () => {});
  // two turns, per-turn semantics (verified by live probe 2026-07-19)
  sock.fire('message', JSON.stringify({ usageMetadata: {
    promptTokenCount: 371, responseTokenCount: 85,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 145 }, { modality: 'AUDIO', tokenCount: 226 }],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 85 }],
  } }));
  sock.fire('message', JSON.stringify({ usageMetadata: {
    promptTokenCount: 504, responseTokenCount: 64,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 171 }, { modality: 'AUDIO', tokenCount: 333 }],
    responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 60 }, { modality: 'TEXT', tokenCount: 4 }],
  } }));
  // details-free message falls back to the plain counts as text
  sock.fire('message', JSON.stringify({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 5 } }));
  assert.deepEqual(up.usageTotals, {
    input_text: 145 + 171 + 10,
    input_audio: 226 + 333,
    output_text: 4 + 5,
    output_audio: 85 + 60,
  });
});

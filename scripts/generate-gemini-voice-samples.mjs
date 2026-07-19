#!/usr/bin/env node
/**
 * Generate short Chinese voice samples for every GEMINI_VOICES entry via the
 * Gemini Live API (native-audio models are Live-only, so the TTS endpoint
 * can't produce the same voices). Output: assets/voice-samples/<Voice>.wav
 * (24kHz mono pcm16), alongside the OpenAI samples. Run manually when the
 * voice list or sample line changes:
 *
 *   node scripts/generate-gemini-voice-samples.mjs
 *
 * Requires GEMINI_API_KEY (and optionally HTTPS_PROXY) in ~/zylos/.env or env.
 */

import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { GEMINI_VOICES } from '../src/lib/gemini-live.js';

const SAMPLE_LINE = '你好，我是语音日报助手。今天有什么进展，随时和我聊。';
const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'voice-samples');

function loadEnv() {
  const out = { ...process.env };
  try {
    for (const line of readFileSync(path.join(os.homedir(), 'zylos', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) out[m[1]] = m[2];
    }
  } catch { /* env file optional */ }
  return out;
}
const env = loadEnv();
if (!env.GEMINI_API_KEY) {
  console.error('No GEMINI_API_KEY found');
  process.exit(1);
}
const proxy = env.HTTPS_PROXY || env.HTTP_PROXY || null;

function wavFromPcm16(pcm, rate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function generate(voice) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
    });
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 60_000);
    const done = (err, val) => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } err ? reject(err) : resolve(val); };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            thinkingConfig: { thinkingBudget: 0 },
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
          systemInstruction: { parts: [{ text: '你是一个语音样音生成器。收到指令后，用自然、友好的语气把指定句子念出来，一字不差，不要添加任何其他内容。' }] },
        },
      }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.setupComplete) {
        ws.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: `请念出这句话：${SAMPLE_LINE}` }] }],
            turnComplete: true,
          },
        }));
        return;
      }
      for (const part of msg.serverContent?.modelTurn?.parts || []) {
        if (part.inlineData?.data) chunks.push(Buffer.from(part.inlineData.data, 'base64'));
      }
      if (msg.serverContent?.turnComplete) done(null, Buffer.concat(chunks));
      if (msg.error) done(new Error(msg.error.message || 'gemini error'));
    });
    ws.on('error', err => done(err));
    ws.on('close', (code, reason) => {
      if (chunks.length) done(null, Buffer.concat(chunks));
      else done(new Error(`closed ${code} ${String(reason || '').slice(0, 120)}`));
    });
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const voice of GEMINI_VOICES) {
  process.stdout.write(`${voice}... `);
  // idempotent across transient failures: delete a file to regenerate it
  if (existsSync(path.join(OUT_DIR, `${voice}.wav`))) {
    console.log('exists, skip');
    continue;
  }
  try {
    const pcm = await generate(voice);
    if (pcm.length < 24000) throw new Error(`too short (${pcm.length} bytes)`);
    writeFileSync(path.join(OUT_DIR, `${voice}.wav`), wavFromPcm16(pcm));
    console.log(`ok (${(pcm.length / 48000).toFixed(1)}s)`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

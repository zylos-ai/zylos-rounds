#!/usr/bin/env node
/**
 * Generate short Chinese voice samples for every VOICE_OPTIONS entry via the
 * OpenAI Realtime API (marin/cedar are realtime-only, so the TTS endpoint
 * can't produce them). Output: assets/voice-samples/<voice>.wav (24kHz mono
 * pcm16). Run manually when the voice list or sample line changes:
 *
 *   node scripts/generate-voice-samples.mjs
 *
 * Requires OPENAI_API_KEY (and optionally HTTPS_PROXY) in ~/zylos/.env or env.
 */

import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvSecrets } from '../src/lib/config.js';
import { VOICE_OPTIONS } from '../src/lib/settings.js';

const SAMPLE_LINE = '你好，我是语音日报助手。今天有什么进展，随时和我聊。';
const MODEL = 'gpt-realtime-2.1';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'voice-samples');

const env = loadEnvSecrets();
if (!env.openaiApiKey) {
  console.error('No OPENAI_API_KEY found');
  process.exit(1);
}

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
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      agent: env.proxy ? new HttpsProxyAgent(env.proxy) : undefined,
      headers: { Authorization: `Bearer ${env.openaiApiKey}` },
    });
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 60_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          instructions: '你是一个语音样音生成器。收到指令后，用自然、友好的语气把指定句子念出来，一字不差，不要添加任何其他内容。',
          audio: {
            input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null },
            output: { voice, format: { type: 'audio/pcm', rate: 24000 } },
          },
        },
      }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.type) {
        case 'session.updated':
          ws.send(JSON.stringify({
            type: 'response.create',
            response: { instructions: `请念出这句话：${SAMPLE_LINE}` },
          }));
          break;
        case 'response.output_audio.delta':
          chunks.push(Buffer.from(msg.delta, 'base64'));
          break;
        case 'response.done':
          clearTimeout(timer);
          ws.close();
          resolve(Buffer.concat(chunks));
          break;
        case 'error':
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.error?.message || 'realtime error'));
          break;
      }
    });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const voice of VOICE_OPTIONS) {
  process.stdout.write(`${voice}... `);
  // idempotent across transient failures: delete a file to regenerate it
  if (existsSync(path.join(OUT_DIR, `${voice}.wav`))) {
    console.log('exists, skip');
    continue;
  }
  try {
    const pcm = await generate(voice);
    if (pcm.length < 24000) throw new Error(`too short (${pcm.length} bytes)`);
    const file = path.join(OUT_DIR, `${voice}.wav`);
    writeFileSync(file, wavFromPcm16(pcm));
    console.log(`ok (${(pcm.length / 48000).toFixed(1)}s)`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

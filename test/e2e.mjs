// E2E: drive a full standup voice session through the local relay with synthetic speech.
// Requires: component running locally, a valid member token, and clip*.pcm files
// (24kHz pcm16 mono Chinese speech — see test/gen-audio.mjs).
//
// usage: node test/e2e.mjs <member-token> [port]
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.argv[2];
const PORT = Number(process.argv[3] || 3478);
if (!TOKEN) { console.error('usage: node test/e2e.mjs <member-token> [port]'); process.exit(1); }

const clips = [0, 1, 2, 3].map(i => fs.readFileSync(path.join(__dirname, `clip${i}.pcm`)));
const SILENCE = Buffer.alloc(24000 * 2 * 1.5); // 1.5s of silence to trigger VAD end-of-turn
const t0 = Date.now(); const ms = () => `${Date.now() - t0}ms`;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
let clipIdx = 0, sending = false, saved = null;

async function sendClip(i) {
  if (sending || i >= clips.length) return;
  sending = true;
  clipIdx = i + 1;
  console.log(`[${ms()}] >> sending clip ${i}`);
  const data = Buffer.concat([clips[i], SILENCE]);
  const CHUNK = 4800; // 100ms of pcm16@24k
  for (let o = 0; o < data.length; o += CHUNK) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.subarray(o, o + CHUNK).toString('base64') }));
    await new Promise(r => setTimeout(r, 95)); // ~realtime pace
  }
  sending = false;
}

ws.on('open', () => console.log(`[${ms()}] connected to relay`));
ws.on('close', () => { console.log(`[${ms()}] closed`); report(); });
ws.on('error', e => { console.log('ws error', e.message); process.exit(1); });

ws.on('message', raw => {
  const ev = JSON.parse(raw.toString());
  switch (ev.type) {
    case 'app.ready': console.log(`[${ms()}] app.ready`); break;
    case 'response.output_audio_transcript.done':
      console.log(`[${ms()}] AI: ${ev.transcript}`); break;
    case 'conversation.item.input_audio_transcription.completed':
      console.log(`[${ms()}] ME(asr): ${(ev.transcript || '').trim()}`); break;
    case 'app.saved':
      saved = ev.summary; console.log(`[${ms()}] ✅ app.saved:`, JSON.stringify(ev.summary, null, 1)); break;
    case 'response.done':
      if (saved) { setTimeout(() => ws.close(), 3000); break; } // goodbye finished
      if (!sending && clipIdx < clips.length) setTimeout(() => sendClip(clipIdx), 600);
      break;
    case 'error': console.log(`[${ms()}] API ERROR`, JSON.stringify(ev.error)); break;
  }
});

function report() {
  console.log('\n=== RESULT ===');
  console.log(saved ? 'SUMMARY SUBMITTED ✔' : 'NO SUMMARY ✘');
  process.exit(saved ? 0 : 1);
}
setTimeout(() => { console.log('E2E TIMEOUT'); report(); }, 5 * 60 * 1000);

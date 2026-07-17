// Generate synthetic "user speech" PCM clips via the realtime API (used only for E2E testing).
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(process.env.HOME, 'zylos/.env'), 'utf8').split('\n')
  .map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]));

const SENTENCES = [
  '昨天我主要在做语音日报功能的联调，另外修了两个线上小 bug。',
  '今天准备把汇总报告的页面做完，然后开始写使用文档。',
  '有一个卡点，测试环境的代理偶尔不稳定，可能需要运维帮忙看一下。',
  '我想在日会上讨论一下，日报流程要不要全组都切到语音方式。',
];

const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-mini', {
  agent: new HttpsProxyAgent(env.HTTPS_PROXY || env.HTTP_PROXY),
  headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
});

let idx = 0, chunks = [];
ws.on('open', () => console.log('open'));
ws.on('message', raw => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === 'session.created') {
    ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'], audio: { output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24000 } } }, instructions: '你是朗读机。用户给什么句子，你就用自然的语气一字不差地朗读那句话，绝不添加任何其他内容。' } }));
    next();
  } else if (ev.type === 'response.output_audio.delta') {
    chunks.push(Buffer.from(ev.delta, 'base64'));
  } else if (ev.type === 'response.done') {
    const f = path.join(__dirname, `clip${idx}.pcm`);
    fs.writeFileSync(f, Buffer.concat(chunks));
    console.log(f, Buffer.concat(chunks).length, 'bytes');
    chunks = []; idx++;
    if (idx >= SENTENCES.length) { ws.close(); process.exit(0); }
    next();
  } else if (ev.type === 'error') console.log('ERR', JSON.stringify(ev.error));
});
function next() {
  ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `请朗读：${SENTENCES[idx]}` }] } }));
  ws.send(JSON.stringify({ type: 'response.create' }));
}
setTimeout(() => { console.log('timeout'); process.exit(2); }, 120000);

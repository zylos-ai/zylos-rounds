import WebSocket from 'ws';
import fs from 'fs';
const KEY = fs.readFileSync(process.env.HOME + '/zylos/.env', 'utf8').match(/^GEMINI_API_KEY=(.*)$/m)[1].trim();
const MODEL = process.argv[2] || 'models/gemini-2.5-flash-native-audio-latest';
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;
const ws = new WebSocket(url);
let audioBytes = 0, outText = '', done = false;
const t0 = Date.now();
const bail = setTimeout(() => { console.log('TIMEOUT after 30s; audioBytes=', audioBytes); ws.close(); process.exit(1); }, 30000);
ws.on('open', () => {
  console.log('WS open', Date.now() - t0, 'ms');
  ws.send(JSON.stringify({
    setup: {
      model: MODEL,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: '你是日报助手 Luna，说中文，回答简短。' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }));
});
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.setupComplete) {
    console.log('setupComplete', Date.now() - t0, 'ms');
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '你好，简单介绍一下你自己' }] }], turnComplete: true } }));
    return;
  }
  const sc = m.serverContent;
  if (sc) {
    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) audioBytes += Buffer.from(p.inlineData.data, 'base64').length;
    }
    if (sc.outputTranscription?.text) outText += sc.outputTranscription.text;
    if (sc.interrupted) console.log('interrupted');
    if (sc.turnComplete && !done) {
      done = true;
      console.log('turnComplete', Date.now() - t0, 'ms; audioBytes=', audioBytes, '≈', (audioBytes / 48000).toFixed(1), 's @24k; transcript:', outText.slice(0, 120));
      clearTimeout(bail); ws.close(); process.exit(0);
    }
  }
  if (m.usageMetadata && done) {}
});
ws.on('error', (e) => { console.log('WS error:', e.message); process.exit(1); });
ws.on('close', (c, r) => console.log('closed', c, r?.toString?.().slice(0, 200)));

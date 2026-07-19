// Isolate: send real 16k audio input; which config/model rejects CONTENT_TYPE_AUDIO?
import WebSocket from 'ws';
import fs from 'fs';
const KEY = fs.readFileSync(process.env.HOME + '/zylos/.env', 'utf8').match(/^GEMINI_API_KEY=(.*)$/m)[1].trim();
const MODEL = process.argv[2] || 'models/gemini-2.5-flash-native-audio-latest';
const MODE = process.argv[3] || 'both-transcriptions'; // or 'no-transcriptions', 'no-tools'
// clip0.pcm is 24k s16le -> naive 1.5 decimate to 16k
const c24 = fs.readFileSync('test/clip0.pcm');
const n = c24.length >> 1, out = [];
for (let p = 0; p + 1 < n; p += 1.5) { const i = Math.floor(p), f = p - i; out.push(Math.round(c24.readInt16LE(i*2)*(1-f)+c24.readInt16LE((i+1)*2)*f)); }
const pcm16k = Buffer.alloc(out.length*2); out.forEach((v,i)=>pcm16k.writeInt16LE(Math.max(-32768,Math.min(32767,v)),i*2));
const silence = Buffer.alloc(16000*2*2); // 2s
const audio = Buffer.concat([pcm16k, silence]);

const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`);
const t0 = Date.now(); const ms=()=>Date.now()-t0;
let audioBytes=0, inTx='', outTx='', turns=0;
ws.on('open', () => {
  const setup = {
    model: MODEL,
    generationConfig: { responseModalities: ['AUDIO'] },
    systemInstruction: { parts: [{ text: '你是日报助手，说中文，简短回应对方说的话，然后问一个问题。' }] },
  };
  if (MODE !== 'no-transcriptions') { setup.inputAudioTranscription = {}; setup.outputAudioTranscription = {}; }
  if (MODE === 'with-tools') setup.tools = [{ functionDeclarations: [{ name: 'submit_standup_summary', description: 'x', parameters: { type: 'object', properties: { yesterday: { type: 'array', items: { type: 'string' } } }, required: [] } }] }];
  ws.send(JSON.stringify({ setup }));
});
async function streamAudio() {
  console.log(ms(), 'streaming audio turn...');
  const CHUNK = 3200; // 100ms @16k
  for (let o = 0; o < audio.length; o += CHUNK) {
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: audio.subarray(o, o+CHUNK).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    await new Promise(r=>setTimeout(r,90));
  }
  console.log(ms(), 'audio turn sent');
}
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.setupComplete) { console.log(ms(),'setupComplete'); streamAudio(); return; }
  const sc = m.serverContent; if (!sc) return;
  if (sc.inputTranscription?.text) inTx += sc.inputTranscription.text;
  if (sc.outputTranscription?.text) outTx += sc.outputTranscription.text;
  for (const p of sc.modelTurn?.parts||[]) if (p.inlineData) audioBytes += Buffer.from(p.inlineData.data,'base64').length;
  if (sc.turnComplete) {
    turns++;
    console.log(ms(), `turn ${turns} complete; audio ${(audioBytes/48000).toFixed(1)}s; ME="${inTx.trim()}" AI="${outTx.trim().slice(0,80)}"`);
    audioBytes=0; inTx=''; outTx='';
    if (turns === 1) streamAudio(); // second audio turn to test repeated input
    else { console.log('OK: two audio turns survived'); ws.close(); process.exit(0); }
  }
});
ws.on('close',(c,r)=>{ console.log(ms(),'CLOSE',c,String(r||'').slice(0,150)); process.exit(c===1000?0:1); });
ws.on('error',e=>console.log('ERR',e.message));
setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},90000);

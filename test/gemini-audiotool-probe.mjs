// Repro attempt: AUDIO input turn whose response should be a function call.
import WebSocket from 'ws';
import fs from 'fs';
const KEY = fs.readFileSync(process.env.HOME + '/zylos/.env', 'utf8').match(/^GEMINI_API_KEY=(.*)$/m)[1].trim();
const MODEL = process.argv[2];
const c24 = fs.readFileSync('test/clip0.pcm');
const n = c24.length >> 1, out = [];
for (let p = 0; p + 1 < n; p += 1.5) { const i = Math.floor(p), f = p - i; out.push(Math.round(c24.readInt16LE(i*2)*(1-f)+c24.readInt16LE((i+1)*2)*f)); }
const pcm = Buffer.alloc(out.length*2); out.forEach((v,i)=>pcm.writeInt16LE(Math.max(-32768,Math.min(32767,v)),i*2));
const audio = Buffer.concat([pcm, Buffer.alloc(16000*2*2)]);
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`);
const t0=Date.now(); const ms=()=>Date.now()-t0;
let sawTool=false;
ws.on('open', () => ws.send(JSON.stringify({ setup: {
  model: MODEL,
  generationConfig: { responseModalities: ['AUDIO'] },
  systemInstruction: { parts: [{ text: '你是日报助手。用户说完任何一句话之后，你必须立即调用 submit_standup_summary 工具提交小结，把听到的内容放进 yesterday。' }] },
  tools: [{ functionDeclarations: [{ name: 'submit_standup_summary', description: '提交日报小结', parameters: { type: 'object', properties: { yesterday: { type: 'array', items: { type: 'string' } }, today: { type: 'array', items: { type: 'string' } } }, required: ['yesterday','today'] } }] }],
  inputAudioTranscription: {}, outputAudioTranscription: {},
} })));
async function stream() {
  const CHUNK=3200;
  for (let o=0;o<audio.length;o+=CHUNK){ ws.send(JSON.stringify({ realtimeInput:{ audio:{ data: audio.subarray(o,o+CHUNK).toString('base64'), mimeType:'audio/pcm;rate=16000' } } })); await new Promise(r=>setTimeout(r,90)); }
  console.log(ms(),'audio sent');
}
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.setupComplete) { console.log(ms(),'setup ok'); stream(); return; }
  if (m.toolCall) { sawTool=true; console.log(ms(),'✅ TOOL CALL after audio input:', JSON.stringify(m.toolCall.functionCalls?.[0]?.args).slice(0,120));
    const fc=m.toolCall.functionCalls[0];
    ws.send(JSON.stringify({ toolResponse:{ functionResponses:[{ id:fc.id, name:fc.name, response:{ok:true} }] } })); return; }
  const sc=m.serverContent;
  if (sc?.outputTranscription?.text) process.stdout.write(sc.outputTranscription.text);
  if (sc?.turnComplete) console.log('\n'+ms(),'turn complete');
});
ws.on('close',(c,r)=>{ console.log(ms(),'CLOSE',c,String(r||'').slice(0,160)); process.exit(sawTool?0:1); });
setTimeout(()=>{ console.log('TIMEOUT', sawTool?'✓':'✗'); process.exit(sawTool?0:1); }, 45000);

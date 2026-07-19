// Does an actual function CALL survive in an AUDIO-modality live session?
import WebSocket from 'ws';
import fs from 'fs';
const KEY = fs.readFileSync(process.env.HOME + '/zylos/.env', 'utf8').match(/^GEMINI_API_KEY=(.*)$/m)[1].trim();
const MODEL = process.argv[2];
const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`);
const t0=Date.now(); const ms=()=>Date.now()-t0;
ws.on('open', () => ws.send(JSON.stringify({ setup: {
  model: MODEL,
  generationConfig: { responseModalities: ['AUDIO'] },
  systemInstruction: { parts: [{ text: '你是日报助手。当用户要求提交小结时，立即调用 submit_standup_summary 工具。' }] },
  tools: [{ functionDeclarations: [{ name: 'submit_standup_summary', description: '提交日报小结', parameters: { type: 'object', properties: { yesterday: { type: 'array', items: { type: 'string' } }, today: { type: 'array', items: { type: 'string' } } }, required: ['yesterday','today'] } }] }],
  outputAudioTranscription: {},
} })));
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.setupComplete) {
    console.log(ms(),'setup ok; requesting tool call via text turn');
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '昨天我修了bug，今天写文档。请现在调用 submit_standup_summary 提交小结。' }] }], turnComplete: true } }));
    return;
  }
  if (m.toolCall) {
    console.log(ms(),'✅ TOOL CALL RECEIVED:', JSON.stringify(m.toolCall.functionCalls?.map(f=>({name:f.name,args:f.args}))).slice(0,200));
    const fc = m.toolCall.functionCalls[0];
    ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { ok: true, message: '已保存' } }] } }));
    console.log(ms(),'toolResponse sent; waiting for model to continue...');
    return;
  }
  const sc = m.serverContent;
  if (sc?.outputTranscription?.text) process.stdout.write(sc.outputTranscription.text);
  if (sc?.turnComplete) { console.log('\n'+ms(),'turn complete'); }
});
let sawTool=false;
ws.on('message', raw => { if (JSON.parse(raw.toString()).toolCall) sawTool=true; });
ws.on('close',(c,r)=>{ console.log(ms(),'CLOSE',c,String(r||'').slice(0,150)); process.exit(sawTool && (c===1000||c===1005) ? 0 : (sawTool?0:1)); });
setTimeout(()=>{ console.log('DONE(timeout)', sawTool?'tool called ✓':'no tool call ✗'); process.exit(sawTool?0:1); }, 30000);

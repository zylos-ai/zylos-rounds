/**
 * WebSocket relay: browser mic <-> this server <-> OpenAI Realtime (via proxy).
 *
 * Ported from the validated voice-standup MVP. Hard-won behaviors preserved:
 * - client event allowlist (browser can only send audio/response/item events)
 * - semantic VAD at low eagerness (don't split long sentences)
 * - dedicated ASR sidecar model for input transcription (realtime models do not
 *   emit input transcripts natively), language pinned zh
 * - anti-hallucination instructions: the model must ask to repeat rather than guess
 * - function call submit_standup_summary -> structured upsert; transcript
 *   accumulated separately and persisted on session end (draft/submitted)
 * - hard session cap + concurrent session cap
 */

import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { todayLocal } from './http-util.js';

const TOOL = {
  type: 'function',
  name: 'submit_standup_summary',
  description: '在日报对话结束时提交结构化小结。当四个主题都聊到（或成员表示没有更多内容）时调用。',
  parameters: {
    type: 'object',
    properties: {
      yesterday: { type: 'array', items: { type: 'string' }, description: '昨天完成/推进的事项，每项一句话' },
      today: { type: 'array', items: { type: 'string' }, description: '今天计划做的事项' },
      blockers: { type: 'array', items: { type: 'string' }, description: '卡点/风险，没有则空数组' },
      topics_for_meeting: { type: 'array', items: { type: 'string' }, description: '需要在日会上讨论的问题，没有则空数组' },
    },
    required: ['yesterday', 'today', 'blockers', 'topics_for_meeting'],
  },
};

const instructions = name => `你是团队的日报助手 Luna，正在和同事「${name}」做每日语音汇报，全程说中文，口语自然、简短友好。
流程：先简单打个招呼，然后依次了解四件事：1) 昨天做了什么；2) 今天准备做什么；3) 有什么卡点或风险；4) 有什么问题需要在今天日会上讨论。
规则：一次只问一个问题；对方说得具体就不追问，说得模糊可以追问一句（最多一句）；整个对话控制在五分钟以内；对方明显说完了就进入下一题。
最重要的规则：只回应对方真实说过的内容。如果没听清、没听懂或音频断续，直接说"不好意思我没听清，能再说一遍吗"，绝对禁止猜测、脑补或编造对方没说过的事，更不能把猜测写进小结。等对方把话说完再开口，不要抢话。
结束：四件事都聊到后，调用 submit_standup_summary 提交小结，然后用一两句话口头跟对方确认要点并道别。不要念出完整清单，不要提"函数"或任何技术细节。`;

const ALLOWED_CLIENT_EVENTS = new Set([
  'input_audio_buffer.append', 'input_audio_buffer.commit', 'input_audio_buffer.clear',
  'response.create', 'response.cancel', 'conversation.item.create', 'conversation.item.truncate',
]);

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

export class Relay {
  constructor(store, getConfig, env) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env;
    this.active = 0;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Attach to the HTTP server's upgrade event. */
  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://internal');
      if (url.pathname !== '/ws') return socket.destroy();
      const cfg = this.getConfig();
      const member = this.store.getMemberByToken(url.searchParams.get('token') || '');
      if (!member || this.active >= (cfg.maxConcurrent ?? 4)) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, ws => this.session(ws, member));
    });
  }

  sessionUpdate(name) {
    const cfg = this.getConfig();
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: instructions(name),
        tools: [TOOL],
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'semantic_vad', eagerness: 'low' },
            transcription: { model: cfg.transcriptionModel ?? 'gpt-realtime-whisper', language: 'zh' },
          },
          output: { voice: cfg.voice ?? 'marin', format: { type: 'audio/pcm', rate: 24000 } },
        },
      },
    };
  }

  session(client, member) {
    const cfg = this.getConfig();
    const model = cfg.model ?? 'gpt-realtime-2.1';
    const maxSessionMs = cfg.maxSessionMs ?? 10 * 60 * 1000;
    const reportDate = todayLocal(cfg.timeZone);
    this.active++;
    const startedAt = Date.now();
    const transcript = [];
    let saved = false;
    console.log(`[standup] session start ${member.name}`);

    const upstream = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      agent: this.env.proxy ? new HttpsProxyAgent(this.env.proxy) : undefined,
      headers: { Authorization: `Bearer ${this.env.openaiApiKey}` },
    });

    const killTimer = setTimeout(() => finish('timeout'), maxSessionMs);
    let closed = false;
    const store = this.store;
    const self = this;
    function finish(reason) {
      if (closed) return;
      closed = true;
      clearTimeout(killTimer);
      try { upstream.close(); } catch { /* already closed */ }
      try { client.close(); } catch { /* already closed */ }
      self.active = Math.max(0, self.active - 1);
      const dur = Math.round((Date.now() - startedAt) / 1000);
      if (transcript.length) {
        store.appendTranscript(member.id, reportDate, transcript.join('\n'), dur, model, saved);
      }
      console.log(`[standup] session end ${member.name} (${reason}, ${dur}s, saved=${saved})`);
    }

    upstream.on('open', () => upstream.send(JSON.stringify(this.sessionUpdate(member.name))));
    upstream.on('error', e => {
      console.error('[standup] upstream error', e.message);
      safeSend(client, { type: 'app.error', message: '上游连接失败' });
      finish('upstream_error');
    });
    upstream.on('close', () => finish('upstream_close'));
    client.on('error', () => finish('client_error'));
    client.on('close', () => finish('client_close'));

    client.on('message', raw => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      if (ev.type === 'app.client_info') {
        // device diagnostics — capture-side audio issues show up here first
        console.log(`[standup] client ${member.name} ctx_rate=${ev.ctx_rate} ua=${ev.ua}`);
        return;
      }
      if (ev.type === 'app.end') {
        safeSend(upstream, { type: 'response.cancel' });
        safeSend(upstream, { type: 'response.create', response: { instructions: '对方要结束对话了。如果还没提交小结，现在立刻调用 submit_standup_summary，然后简短道别。' } });
        return;
      }
      if (ALLOWED_CLIENT_EVENTS.has(ev.type) && upstream.readyState === WebSocket.OPEN) {
        upstream.send(raw.toString());
      }
    });

    upstream.on('message', raw => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      switch (ev.type) {
        case 'session.updated':
          safeSend(client, { type: 'app.ready' });
          // model opens the conversation
          safeSend(upstream, { type: 'response.create' });
          return;
        case 'conversation.item.input_audio_transcription.completed':
          if (ev.transcript?.trim()) transcript.push(`${member.name}: ${ev.transcript.trim()}`);
          break;
        case 'response.output_audio_transcript.done':
          if (ev.transcript?.trim()) transcript.push(`Luna: ${ev.transcript.trim()}`);
          break;
        case 'response.done': {
          const fc = (ev.response?.output || []).find(i => i.type === 'function_call' && i.name === 'submit_standup_summary');
          if (fc) {
            try {
              const args = JSON.parse(fc.arguments);
              this.store.upsertSummary(member.id, reportDate, args, fc.arguments, model);
              saved = true;
              safeSend(client, { type: 'app.saved', summary: args });
              safeSend(upstream, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: fc.call_id, output: '{"ok":true,"message":"已保存"}' } });
              safeSend(upstream, { type: 'response.create' });
            } catch (e) {
              console.error('[standup] summary parse error', e);
            }
          }
          break;
        }
        case 'conversation.item.input_audio_transcription.failed':
          console.error('[standup] asr failed', JSON.stringify(ev.error || ev));
          break;
        case 'error':
          // app.end fires response.cancel unconditionally; when no response is
          // active the API answers with this benign error — swallow it, or the
          // client re-enables the submit button mid-wrap-up.
          if (ev.error?.code === 'response_cancel_not_active') return;
          console.error('[standup] api error', JSON.stringify(ev.error));
          safeSend(client, { type: 'app.error', message: ev.error?.message || '上游错误' });
          return; // already delivered as app.error — don't forward the raw event too
      }
      safeSend(client, ev); // forward everything to the client
    });
  }
}

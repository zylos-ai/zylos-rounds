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

const SUBMIT_TOOL = {
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

// On-demand retrieval tools — the agent calls these mid-conversation when it
// judges it needs context. Results are handled in the response.done branch.
const RECALL_TOOL = {
  type: 'function',
  name: 'recall_member_history',
  description: '查看这位同事最近几次的日报（昨天/今天/卡点/待议题）。当你想确认对方上次说了什么、或想跟进之前的进展或卡点时调用。',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '回看最近几次汇报，默认 5，最多 10' },
    },
    required: [],
  },
};

const KNOWLEDGE_TOOL = {
  type: 'function',
  name: 'search_team_knowledge',
  description: '检索团队知识库。当对方提到某个项目/名词你需要背景、或需要核对团队已有信息时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词，用空格分隔多个词' },
    },
    required: ['query'],
  },
};

// Oneshot communication tasks submit a generic summary instead of the
// standup's four fixed buckets (the question frame is free text, so the
// output shape stays generic: 分条要点 + 值得负责人注意的信号).
const ONESHOT_SUBMIT_TOOL = {
  type: 'function',
  name: 'submit_conversation_summary',
  description: '在这次一对一沟通结束时提交结构化小结。当问题框架里的要点都聊到（或对方表示没有更多内容）时调用。',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'array', items: { type: 'string' }, description: '对话要点，按主题分条，每条一句话，忠实于对方原意' },
      highlights: { type: 'array', items: { type: 'string' }, description: '值得负责人特别注意的重点信号（分歧、强烈观点、风险、诉求），没有则空数组' },
    },
    required: ['summary', 'highlights'],
  },
};

const TOOLS = [SUBMIT_TOOL, RECALL_TOOL, KNOWLEDGE_TOOL];
const ONESHOT_TOOLS = [ONESHOT_SUBMIT_TOOL, RECALL_TOOL, KNOWLEDGE_TOOL];

const ALLOWED_CLIENT_EVENTS = new Set([
  'input_audio_buffer.append', 'input_audio_buffer.commit', 'input_audio_buffer.clear',
  'response.create', 'response.cancel', 'conversation.item.create', 'conversation.item.truncate',
]);

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

export class Relay {
  constructor(store, getConfig, env, settings, context, profiles) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env;
    this.settings = settings; // resolves key/model/voice per session (env > DB > config)
    this.context = context;   // AgentContext: composes instructions + retrieval
    this.profiles = profiles; // ProfileUpdater: merges submitted reports into 动态画像
    this.active = 0;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Link-driven routing (owner ruling 2026-07-18): the permanent member token
   * routes to the built-in recurring standup; a per-(task, member) token routes
   * to that oneshot task's conversation. Returns null for unknown tokens.
   */
  resolveToken(token) {
    const member = this.store.getMemberByToken(token);
    if (member) return { member, task: this.store.getDailyTask() || null };
    return this.store.getTaskSessionByToken(token);
  }

  /** Attach to the HTTP server's upgrade event. */
  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://internal');
      if (url.pathname !== '/ws') return socket.destroy();
      const cfg = this.getConfig();
      const resolved = this.resolveToken(url.searchParams.get('token') || '');
      if (!resolved || this.active >= (cfg.maxConcurrent ?? 4)) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, ws => this.session(ws, resolved.member, resolved.task));
    });
  }

  sessionUpdate(member, task) {
    const cfg = this.getConfig();
    const oneshot = task && task.type === 'oneshot';
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: this.context.buildInstructions(member, task),
        tools: oneshot ? ONESHOT_TOOLS : TOOLS,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'semantic_vad', eagerness: 'low' },
            transcription: { model: cfg.transcriptionModel ?? 'gpt-realtime-whisper', language: 'zh' },
          },
          output: { voice: this.settings.resolveVoice(), format: { type: 'audio/pcm', rate: 24000 } },
        },
      },
    };
  }

  /**
   * Dispatch a realtime function_call. submit_standup_summary ends the flow;
   * the retrieval tools return data and prompt the model to continue speaking.
   */
  handleToolCall(fc, { client, upstream, member, task, reportDate, model, markSaved }) {
    const respond = output => {
      safeSend(upstream, {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: fc.call_id, output: typeof output === 'string' ? output : JSON.stringify(output) },
      });
      safeSend(upstream, { type: 'response.create' });
    };
    let args = {};
    try { args = JSON.parse(fc.arguments || '{}'); } catch { /* keep empty args */ }

    switch (fc.name) {
      case 'submit_standup_summary':
        try {
          this.store.upsertSummary(member.id, reportDate, args, fc.arguments, model);
          markSaved();
          safeSend(client, { type: 'app.saved', summary: args });
          respond({ ok: true, message: '已保存' });
        } catch (e) {
          console.error('[rounds] summary parse error', e);
        }
        break;
      case 'submit_conversation_summary':
        try {
          const summary = JSON.stringify(Array.isArray(args.summary) ? args.summary : []);
          const highlights = JSON.stringify(Array.isArray(args.highlights) ? args.highlights : []);
          this.store.submitTaskSummary(task.id, member.id, summary, highlights);
          markSaved();
          safeSend(client, { type: 'app.saved', summary: args });
          respond({ ok: true, message: '已保存' });
        } catch (e) {
          console.error('[rounds] task summary parse error', e);
        }
        break;
      case 'recall_member_history': {
        const days = Math.min(10, Math.max(1, Number(args.days) || 5));
        const data = this.context.recallHistory(member, reportDate, days);
        console.log(`[rounds] tool recall_member_history ${member.name} -> ${data.count} reports`);
        respond(data);
        break;
      }
      case 'search_team_knowledge': {
        const data = this.context.searchKnowledge(String(args.query || ''));
        console.log(`[rounds] tool search_team_knowledge "${data.query}" -> ${data.count} hits`);
        respond(data);
        break;
      }
      default:
        console.warn('[rounds] unknown tool call', fc.name);
    }
  }

  session(client, member, task = null) {
    const cfg = this.getConfig();
    const apiKey = this.settings.resolveKey();
    if (!apiKey) {
      safeSend(client, { type: 'app.error', message: '尚未配置 OpenAI API Key，请管理员在设置页配置' });
      client.close();
      return;
    }
    const oneshot = task && task.type === 'oneshot';
    const model = this.settings.resolveModel();
    const maxSessionMs = cfg.maxSessionMs ?? 10 * 60 * 1000;
    const reportDate = todayLocal(cfg.timeZone);
    this.active++;
    const startedAt = Date.now();
    const transcript = [];
    let saved = false;
    console.log(`[rounds] session start ${member.name}${oneshot ? ` (task #${task.id} ${task.title})` : ''}`);

    const upstream = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
      agent: this.env.proxy ? new HttpsProxyAgent(this.env.proxy) : undefined,
      headers: { Authorization: `Bearer ${apiKey}` },
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
        if (oneshot) store.appendTaskTranscript(task.id, member.id, transcript.join('\n'), dur);
        else store.appendTranscript(member.id, reportDate, transcript.join('\n'), dur, model, saved);
      }
      console.log(`[rounds] session end ${member.name} (${reason}, ${dur}s, saved=${saved})`);
      // fire-and-forget: merge the submitted conversation into the member's 动态画像
      if (saved && self.profiles) {
        if (oneshot) self.profiles.updateAfterTaskSession(member.id, task.id);
        else self.profiles.updateAfterReport(member.id, reportDate);
      }
    }

    upstream.on('open', () => upstream.send(JSON.stringify(this.sessionUpdate(member, task))));
    upstream.on('error', e => {
      console.error('[rounds] upstream error', e.message);
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
        console.log(`[rounds] client ${member.name} ctx_rate=${ev.ctx_rate} ua=${ev.ua}`);
        return;
      }
      if (ev.type === 'app.end') {
        const submitTool = oneshot ? 'submit_conversation_summary' : 'submit_standup_summary';
        safeSend(upstream, { type: 'response.cancel' });
        safeSend(upstream, { type: 'response.create', response: { instructions: `对方要结束对话了。如果还没提交小结，现在立刻调用 ${submitTool}，然后简短道别。` } });
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
          const calls = (ev.response?.output || []).filter(i => i.type === 'function_call');
          for (const fc of calls) this.handleToolCall(fc, { client, upstream, member, task, reportDate, model, markSaved: () => { saved = true; } });
          break;
        }
        case 'conversation.item.input_audio_transcription.failed':
          console.error('[rounds] asr failed', JSON.stringify(ev.error || ev));
          break;
        case 'error':
          // app.end fires response.cancel unconditionally; when no response is
          // active the API answers with this benign error — swallow it, or the
          // client re-enables the submit button mid-wrap-up.
          if (ev.error?.code === 'response_cancel_not_active') return;
          console.error('[rounds] api error', JSON.stringify(ev.error));
          safeSend(client, { type: 'app.error', message: ev.error?.message || '上游错误' });
          return; // already delivered as app.error — don't forward the raw event too
      }
      safeSend(client, ev); // forward everything to the client
    });
  }
}

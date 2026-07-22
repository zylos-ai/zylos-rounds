/**
 * WebSocket relay: browser mic <-> this server <-> OpenAI Realtime (via proxy).
 *
 * Ported from the validated voice-standup MVP. Hard-won behaviors preserved:
 * - client event allowlist (browser can only send audio/response/item events)
 * - semantic VAD at low eagerness (don't split long sentences)
 * - dedicated ASR sidecar model for input transcription (realtime models do not
 *   emit input transcripts natively), language pinned to the member's language
 * - anti-hallucination instructions: the model must ask to repeat rather than guess
 * - function call submit_standup_summary -> structured upsert; transcript
 *   accumulated separately and persisted on session end (draft/submitted)
 * - hard session cap + concurrent session cap
 */

import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { todayLocal } from './http-util.js';
import { ONESHOT_CYCLE, currentCycleKey } from './cycle.js';
import { GeminiUpstream } from './gemini-live.js';
import { resolvePrices, costUsd } from './pricing.js';

// Tool descriptions guide the model, so they follow the member's language.
// The zh set is the original battle-tested wording; en mirrors it one-to-one.
const TOOL_STRINGS = {
  zh: {
    submit: '在日报对话结束时提交结构化小结。当四个主题都聊到（或成员表示没有更多内容）时调用。',
    yesterday: '昨天完成/推进的事项，每项一句话',
    today: '今天计划做的事项',
    blockers: '卡点：前置依赖——在等谁/等什么、卡住了哪件事；点对点沟通就能解决的阻塞放这里。没有则空数组',
    topics: '待议题：需要上日会的事——多方拉通对齐、方案取舍、需要负责人拍板，一对一解决不了的。没有则空数组',
    recall: '查看这位同事最近几次的日报（昨天/今天/卡点/待议题）。当你想确认对方上次说了什么、或想跟进之前的进展或卡点时调用。',
    recallDays: '回看最近几次汇报，默认 5，最多 10',
    knowledge: '检索团队知识库。当对方提到某个项目/名词你需要背景、或需要核对团队已有信息时调用。',
    knowledgeQuery: '检索关键词，用空格分隔多个词',
    genericSubmit: '在这次一对一沟通结束时提交结构化小结。当问题框架里的要点都聊到（或对方表示没有更多内容）时调用。',
    genericSummary: '对话要点，按主题分条，每条一句话，忠实于对方原意',
    genericHighlights: '值得负责人特别注意的重点信号（分歧、强烈观点、风险、诉求），没有则空数组',
    saved: '已保存',
    endKick: submitTool => `对方要结束对话了。如果还没提交小结，现在立刻调用 ${submitTool}，然后简短道别。`,
    reconnectKick: (generic, submitted) =>
      `（同事重新接通，这是继续${generic ? '本周期' : '今天'}早些时候的对话，不是新对话。` +
      `开场只说一句简短的招呼：如果之前的对话记录里对方实质说过内容，加一句自然衔接（比如"我们接着刚才的继续"），` +
      `${submitted ? '问对方还有什么要补充的' : '从上次中断的地方接着聊'}；` +
      `如果之前基本只有你在说、对方还没实质回答过什么，就不要说"接着刚才"这类话，打完招呼直接自然进入主题。` +
      `绝对不要重新自我介绍，绝对不要把对方已经实质回答过的问题再问一遍，也不要逐条确认；你问过但对方没有回答的问题不算聊过，要重新问。不要提到这条消息）`,
    errNoKey: '尚未配置语音 provider 的 API Key，请管理员在设置页配置',
    errNoCycle: '这个任务的第一个周期还没开始，请稍后再来',
    errUpstream: '上游连接失败',
    errUpstreamGeneric: '上游错误',
  },
  en: {
    submit: 'Submit the structured summary at the end of the standup conversation. Call it once all four topics are covered (or the member says there is nothing more).',
    yesterday: 'Things completed/advanced yesterday, one sentence each',
    today: "Things planned for today",
    blockers: 'Blockers: prerequisite dependencies — who/what they are waiting on and which work it blocks; things solvable point-to-point go here. Empty array if none',
    topics: "Meeting topics: things that need the team meeting — multi-party alignment, trade-off choices, decisions the lead must make; things a one-on-one can't resolve. Empty array if none",
    recall: "Look up this colleague's recent reports (yesterday/today/blockers/topics). Call it when you want to check what they said last time, or follow up on earlier progress or blockers.",
    recallDays: 'How many recent reports to look back over; default 5, max 10',
    knowledge: 'Search the team knowledge base. Call it when they mention a project or term you need background on, or you need to check existing team information.',
    knowledgeQuery: 'Search keywords, separate multiple terms with spaces',
    genericSubmit: 'Submit the structured summary at the end of this one-on-one conversation. Call it once the points in the question frame are covered (or the member says there is nothing more).',
    genericSummary: "Key points of the conversation, one per topic, one sentence each, faithful to what they actually said",
    genericHighlights: 'Signals the lead should pay special attention to (disagreements, strong opinions, risks, asks); empty array if none',
    saved: 'Saved',
    endKick: submitTool => `The member wants to end the conversation. If you have not submitted the summary yet, call ${submitTool} right now, then say a brief goodbye.`,
    reconnectKick: (generic, submitted) =>
      `(The colleague has reconnected — this continues the earlier conversation from ${generic ? 'this cycle' : 'today'}, it is not a new one. ` +
      `Open with a single brief greeting: if the member actually said something substantive in the earlier transcript, add one natural bridge (like "let's pick up where we left off"), ` +
      `${submitted ? 'then ask what they would like to add' : 'then continue from where it broke off'}; ` +
      `if it was mostly you talking and they never gave a substantive answer, do not say anything like "pick up where we left off" — greet and move naturally into the topic. ` +
      `Absolutely do not introduce yourself again, never re-ask questions the member has substantively answered, and do not re-confirm covered things one by one; a question you asked that they never answered is not covered — ask it again. Do not mention this message.)`,
    errNoKey: 'The voice provider API key is not configured yet — please ask the admin to set it on the settings page',
    errNoCycle: "This task's first cycle hasn't started yet — please come back later",
    errUpstream: 'Upstream connection failed',
    errUpstreamGeneric: 'Upstream error',
  },
};

function buildTools(S) {
  const submitTool = {
    type: 'function',
    name: 'submit_standup_summary',
    description: S.submit,
    parameters: {
      type: 'object',
      properties: {
        yesterday: { type: 'array', items: { type: 'string' }, description: S.yesterday },
        today: { type: 'array', items: { type: 'string' }, description: S.today },
        blockers: { type: 'array', items: { type: 'string' }, description: S.blockers },
        topics_for_meeting: { type: 'array', items: { type: 'string' }, description: S.topics },
      },
      required: ['yesterday', 'today', 'blockers', 'topics_for_meeting'],
    },
  };
  // On-demand retrieval tools — the agent calls these mid-conversation when it
  // judges it needs context. Results are handled in the response.done branch.
  const recallTool = {
    type: 'function',
    name: 'recall_member_history',
    description: S.recall,
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: S.recallDays },
      },
      required: [],
    },
  };
  const knowledgeTool = {
    type: 'function',
    name: 'search_team_knowledge',
    description: S.knowledge,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: S.knowledgeQuery },
      },
      required: ['query'],
    },
  };
  // Generic communication tasks (anything but the built-in daily standup)
  // submit a generic summary instead of the standup's four fixed buckets (the
  // question frame is free text, so the output shape stays generic:
  // itemized points + signals worth the lead's attention).
  const genericSubmitTool = {
    type: 'function',
    name: 'submit_conversation_summary',
    description: S.genericSubmit,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'array', items: { type: 'string' }, description: S.genericSummary },
        highlights: { type: 'array', items: { type: 'string' }, description: S.genericHighlights },
      },
      required: ['summary', 'highlights'],
    },
  };
  return {
    daily: [submitTool, recallTool, knowledgeTool],
    generic: [genericSubmitTool, recallTool, knowledgeTool],
  };
}

const TOOLS_BY_LANG = Object.fromEntries(
  Object.entries(TOOL_STRINGS).map(([lang, S]) => [lang, buildTools(S)]),
);

const langStrings = lang => TOOL_STRINGS[lang] || TOOL_STRINGS.zh;
const langTools = lang => TOOLS_BY_LANG[lang] || TOOLS_BY_LANG.zh;

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
   * Link-driven routing (owner v0.7 ruling 2026-07-18): every link is a
   * per-(task, member) token — including the built-in daily standup. The old
   * permanent member tokens no longer route anywhere. Returns null for
   * unknown/expired tokens.
   */
  resolveToken(token) {
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
      // mode=text starts the session with text replies (quiet environments;
      // also lets a text-mode client reconnect without an audible greeting)
      const mode = url.searchParams.get('mode') === 'text' ? 'text' : 'voice';
      this.wss.handleUpgrade(req, socket, head, ws => this.session(ws, resolved.member, resolved.task, mode));
    });
  }

  sessionUpdate(member, task, prior = null, mode = 'voice', followupSnapshot = null, cycleKey = null) {
    const cfg = this.getConfig();
    const generic = task && !task.is_builtin;
    // The member's language drives instructions, tool descriptions and the
    // ASR sidecar language (pinning ASR to the spoken language is one of the
    // hard-won relay invariants — it just follows the member now).
    const lang = this.settings.memberLanguage(member);
    const tools = langTools(lang);
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: mode === 'text' ? ['text'] : ['audio'],
        instructions: this.context.buildInstructions(member, task, prior, this.settings.resolveTimeZone(), lang, followupSnapshot, cycleKey),
        tools: generic ? tools.generic : tools.daily,
        tool_choice: 'auto',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'semantic_vad', eagerness: 'low' },
            transcription: { model: cfg.transcriptionModel ?? 'gpt-realtime-whisper', language: lang },
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
  handleToolCall(fc, { client, upstream, member, task, cycleKey, reportDate, model, markSaved, S = { saved: 'Saved' }, followupSnapshotIds, markAnchor = () => {} }) {
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
          this.store.upsertSummary(member.id, reportDate, args, fc.arguments, model, followupSnapshotIds);
          markAnchor();
          markSaved();
          safeSend(client, { type: 'app.saved', summary: args });
          respond({ ok: true, message: S.saved });
        } catch (e) {
          console.error('[rounds] summary parse error', e);
        }
        break;
      case 'submit_conversation_summary':
        try {
          const summary = JSON.stringify(Array.isArray(args.summary) ? args.summary : []);
          const highlights = JSON.stringify(Array.isArray(args.highlights) ? args.highlights : []);
          this.store.submitCycleSummary(task.id, member.id, cycleKey, summary, highlights, followupSnapshotIds);
          markAnchor();
          markSaved();
          safeSend(client, { type: 'app.saved', summary: args });
          respond({ ok: true, message: S.saved });
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
        const data = this.context.searchKnowledge(String(args.query || ''), task);
        console.log(`[rounds] tool search_team_knowledge "${data.query}" -> ${data.count} hits`);
        respond(data);
        break;
      }
      default:
        console.warn('[rounds] unknown tool call', fc.name);
    }
  }

  session(client, member, task = null, mode = 'voice') {
    const cfg = this.getConfig();
    const conn = this.settings.voiceConnection();
    const apiKey = conn.key;
    const S = langStrings(this.settings.memberLanguage(member));
    if (!apiKey) {
      safeSend(client, { type: 'app.error', message: S.errNoKey });
      client.close();
      return;
    }
    const generic = task && !task.is_builtin;
    const model = conn.model;
    const maxSessionMs = cfg.maxSessionMs ?? 10 * 60 * 1000;
    const reportDate = todayLocal(this.settings.resolveTimeZone());
    // Conversations bind to the cycle current at connect time (lenient windows).
    // A recurring task whose first cycle hasn't started yet has no cycle to
    // record into — reject up front rather than losing the conversation.
    const cycleKey = generic
      ? (task.type === 'oneshot' ? ONESHOT_CYCLE : currentCycleKey(task, reportDate))
      : reportDate;
    if (!cycleKey) {
      safeSend(client, { type: 'app.error', message: S.errNoCycle });
      client.close();
      return;
    }
    this.active++;
    const startedAt = Date.now();
    const transcript = [];
    let saved = false;
    // OpenAI path billing accumulator: response.done usage is per-response
    // (input re-bills the growing context each turn — that is how OpenAI
    // bills, so summing responses reproduces the invoice). The Gemini
    // adapter accumulates its own totals; finish() prefers those.
    const usage = { input_text: 0, input_audio: 0, cached_text: 0, cached_audio: 0, output_text: 0, output_audio: 0, asr_seconds: 0 };
    // Same-cycle continuation: an earlier session today (drop, refresh, or a
    // finished call the member reopens) left its transcript in the store — feed
    // it back so the agent picks up where it left off instead of restarting.
    const priorRec = generic
      ? this.store.getCycleRecord(task.id, member.id, cycleKey)
      : this.store.getReport(member.id, reportDate);
    const prior = priorRec?.transcript
      ? { transcript: priorRec.transcript, submitted: priorRec.status === 'submitted' }
      : null;
    const followupSnapshot = this.context.followupsForTask(task, member, cycleKey);
    const followupSnapshotIds = followupSnapshot.map(f => f.id);
    // Freeze the injection anchor at snapshot time: session-end writes push
    // the record's updated_at past this moment, so the next cycle's
    // since-window must anchor here or mid-session follow-ups are lost.
    // Persisted piggyback on every write path (the row must exist first).
    const snapshotAnchorAt = this.store.nowLocal();
    const markAnchor = () => {
      try {
        this.store.setInjectionAnchor(task, member.id, generic ? cycleKey : reportDate, snapshotAnchorAt);
      } catch (e) { console.log(`[rounds] anchor write failed: ${e.message}`); }
    };
    console.log(`[rounds] session start ${member.name}${generic ? ` (task #${task.id} ${task.title}, cycle ${cycleKey})` : ''}`);

    // Gemini providers speak a different wire protocol — the adapter emulates
    // the OpenAI Realtime surface so everything below stays provider-agnostic.
    const upstream = conn.protocol === 'gemini'
      ? new GeminiUpstream({ wsUrl: conn.wsUrl, key: apiKey, model, proxy: this.env.proxy, lang: this.settings.memberLanguage(member) })
      : new WebSocket(`${conn.wsUrl}?model=${model}`, {
        agent: this.env.proxy && conn.wsUrl.startsWith('wss:') ? new HttpsProxyAgent(this.env.proxy) : undefined,
        headers: { Authorization: `Bearer ${apiKey}` },
      });

    const killTimer = setTimeout(() => finish('timeout'), maxSessionMs);
    // App-level heartbeat: browsers cannot send WS pings, and on flaky mobile
    // links a dead socket can stay half-open for minutes. A 20s beacon gives
    // the client's stale-socket watchdog something to miss.
    const heartbeat = setInterval(() => safeSend(client, { type: 'app.ping' }), 20000);
    heartbeat.unref?.();
    let closed = false;
    let greeted = false;
    const store = this.store;
    const self = this;

    // Incremental durability: persist the conversation as it happens, not only
    // at session end, so a crash/restart mid-call keeps what was already said.
    // Write the contiguous run of already-filled transcript entries, stopping at
    // the first unfilled ASR slot to preserve true conversation order (it flushes
    // once its text arrives). Chunk writes carry duration 0; the real duration is
    // recorded exactly once at finish().
    let flushedIdx = 0;
    function flushTranscript() {
      let end = flushedIdx;
      while (end < transcript.length && transcript[end].text != null) end++;
      const chunk = transcript.slice(flushedIdx, end).map(e => e.text).filter(Boolean);
      if (!chunk.length) { flushedIdx = end; return; }
      try {
        if (generic) store.appendCycleTranscript(task.id, member.id, cycleKey, chunk.join('\n'), 0, followupSnapshotIds);
        else store.appendTranscript(member.id, reportDate, chunk.join('\n'), 0, model, saved, followupSnapshotIds);
        markAnchor();
        flushedIdx = end;
      } catch (e) { console.log(`[rounds] transcript flush failed: ${e.message}`); }
    }
    const flushTimer = setInterval(flushTranscript, 7000);
    flushTimer.unref?.();

    function finish(reason) {
      if (closed) return;
      closed = true;
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      clearInterval(flushTimer);
      try { upstream.close(); } catch { /* already closed */ }
      try { client.close(); } catch { /* already closed */ }
      self.active = Math.max(0, self.active - 1);
      const dur = Math.round((Date.now() - startedAt) / 1000);
      // Entries are ordered slots: user slots are inserted at item-creation
      // time and filled by the (late) ASR result, so the archive keeps true
      // conversation order. Unfilled slots (failed/empty ASR) drop out here.
      // Flush the filled prefix, then persist the remaining tail (entries after
      // an unfilled ASR slot, or the final turn) together with the real duration.
      // Chunks written during the call carried duration 0, so the total lands
      // exactly once; if everything was already flushed, record duration only.
      flushTranscript();
      const tail = transcript.slice(flushedIdx).map(e => e.text).filter(Boolean);
      if (tail.length) {
        if (generic) store.appendCycleTranscript(task.id, member.id, cycleKey, tail.join('\n'), dur, followupSnapshotIds);
        else store.appendTranscript(member.id, reportDate, tail.join('\n'), dur, model, saved, followupSnapshotIds);
        flushedIdx = transcript.length;
      } else if (flushedIdx > 0) {
        if (generic) store.finalizeCycleRecord(task.id, member.id, cycleKey, dur);
        else store.finalizeReport(member.id, reportDate, dur, model, saved);
      }
      if (flushedIdx > 0 || saved) markAnchor();
      console.log(`[rounds] session end ${member.name} (${reason}, ${dur}s, saved=${saved})`);
      // usage/cost row — best-effort, never let accounting break session close
      try {
        const totals = upstream.usageTotals || usage; // Gemini adapter vs OpenAI accumulator
        const any = totals.input_text + totals.input_audio + totals.output_text + totals.output_audio;
        if (any > 0) {
          const asrModel = conn.protocol === 'gemini' ? null : (cfg.transcriptionModel ?? 'gpt-realtime-whisper');
          const row = {
            date: reportDate, slot: 'voice',
            provider: conn.provider?.slug || conn.protocol || 'openai',
            model, member_id: member.id, seconds: dur,
            input_text: totals.input_text, input_audio: totals.input_audio,
            cached_text: totals.cached_text || 0, cached_audio: totals.cached_audio || 0,
            output_text: totals.output_text, output_audio: totals.output_audio,
            asr_seconds: conn.protocol === 'gemini' ? 0 : usage.asr_seconds,
            asr_model: asrModel,
          };
          row.cost_usd = costUsd(row, resolvePrices(store));
          store.insertUsage(row);
          console.log(`[rounds] usage ${member.name} ${model} $${row.cost_usd.toFixed(4)}`);
        }
      } catch (e) {
        console.error('[rounds] usage log failed', e.message);
      }
      // fire-and-forget: merge the submitted conversation into the member's 动态画像
      if (saved && self.profiles) {
        if (generic) self.profiles.updateAfterTaskSession(member.id, task.id, cycleKey);
        else self.profiles.updateAfterReport(member.id, reportDate);
      }
    }

    upstream.on('open', () => upstream.send(JSON.stringify(this.sessionUpdate(member, task, prior, mode, followupSnapshot, cycleKey))));
    upstream.on('error', e => {
      console.error('[rounds] upstream error', e.message);
      safeSend(client, { type: 'app.error', message: S.errUpstream });
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
      if (ev.type === 'app.set_mode') {
        // mid-call voice/text switch — flip the reply modality in place
        mode = ev.mode === 'text' ? 'text' : 'voice';
        if (mode === 'text') safeSend(upstream, { type: 'response.cancel' });
        safeSend(upstream, { type: 'session.update', session: { type: 'realtime', output_modalities: mode === 'text' ? ['text'] : ['audio'] } });
        return;
      }
      if (ev.type === 'app.end') {
        const submitTool = generic ? 'submit_conversation_summary' : 'submit_standup_summary';
        safeSend(upstream, { type: 'response.cancel' });
        safeSend(upstream, { type: 'response.create', response: { instructions: S.endKick(submitTool) } });
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
          // fires again on every mid-call session.update (mode switches) —
          // only the first one greets and opens the conversation
          if (!greeted) {
            greeted = true;
            safeSend(client, { type: 'app.ready' });
            // Continuation sessions must not re-run the scripted opening.
            // Models weigh the opener kick over the instructions block, so
            // the kick itself has to carry the continuation framing.
            const opener = prior ? {
              response: { instructions: S.reconnectKick(generic, prior.submitted) },
            } : null;
            safeSend(upstream, { type: 'response.create', ...(opener || {}) });
          }
          return;
        // A user message item appears in the event stream as soon as the turn
        // is committed — before the model's reply starts. Reserve its slot
        // now; the async ASR result fills it in later (it routinely arrives
        // AFTER the reply's transcript, which used to scramble the order).
        case 'conversation.item.added':
        case 'conversation.item.created':
          if (ev.item?.type === 'message' && ev.item?.role === 'user'
            && !transcript.some(e => e.id === ev.item.id)) {
            // typed messages carry their text up front — no ASR to wait for
            const typed = (ev.item.content || []).find(c => c.type === 'input_text')?.text?.trim();
            transcript.push({ id: ev.item.id, text: typed ? `${member.name}: ${typed}` : null });
          }
          break;
        case 'conversation.item.input_audio_transcription.completed': {
          const text = (ev.transcript || '').trim();
          const slot = transcript.find(e => e.id === ev.item_id);
          if (slot) slot.text = text ? `${member.name}: ${text}` : null;
          else if (text) transcript.push({ id: ev.item_id, text: `${member.name}: ${text}` });
          flushTranscript(); // a filled slot may unblock the persistable prefix
          // ASR sidecar billing (OpenAI path only): the event's usage carries
          // either billed seconds or token counts (~1000 audio tokens/min on
          // the 4o-transcribe rate card — $6/1M ≈ $0.006/min)
          const au = ev.usage;
          if (au?.type === 'duration') usage.asr_seconds += Number(au.seconds) || 0;
          else if (au?.input_token_details?.audio_tokens) usage.asr_seconds += au.input_token_details.audio_tokens * 0.06;
          break;
        }
        case 'response.output_audio_transcript.done':
          if (ev.transcript?.trim()) { transcript.push({ text: `Luna: ${ev.transcript.trim()}` }); flushTranscript(); }
          break;
        case 'response.output_text.done':
        case 'response.text.done':
          if (ev.text?.trim()) { transcript.push({ text: `Luna: ${ev.text.trim()}` }); flushTranscript(); }
          break;
        case 'response.done': {
          const u = ev.response?.usage;
          if (u) {
            const it = u.input_token_details || {};
            const ot = u.output_token_details || {};
            const ct = it.cached_tokens_details || {};
            usage.input_text += it.text_tokens || 0;
            usage.input_audio += it.audio_tokens || 0;
            usage.cached_text += ct.text_tokens || 0;
            usage.cached_audio += ct.audio_tokens || 0;
            usage.output_text += ot.text_tokens || 0;
            usage.output_audio += ot.audio_tokens || 0;
          }
          const calls = (ev.response?.output || []).filter(i => i.type === 'function_call');
          for (const fc of calls) this.handleToolCall(fc, { client, upstream, member, task, cycleKey, reportDate, model, markSaved: () => { saved = true; }, S, followupSnapshotIds, markAnchor });
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
          safeSend(client, { type: 'app.error', message: ev.error?.message || S.errUpstreamGeneric });
          return; // already delivered as app.error — don't forward the raw event too
      }
      safeSend(client, ev); // forward everything to the client
    });
  }
}

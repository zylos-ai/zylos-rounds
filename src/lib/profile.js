/**
 * Dynamic member profile (动态画像) maintenance.
 *
 * After each submitted report, an LLM pass rewrites the member's profile:
 * today's report (structured summary + transcript) is merged into the existing
 * profile, entries are re-dated when re-confirmed, and stale information ages
 * out. The result is injected into the next call's instructions, so the agent
 * accumulates context about each person without anyone writing it by hand.
 *
 * The human-written `context` (基础背景) is separate input — the profile never
 * overwrites it, only complements it. Failures are soft: the previous profile
 * stays in place and the error is logged.
 */

import { callChatModel } from './llm.js';
import { recordTextUsage } from './pricing.js';

export const DEFAULT_PROFILE_MODEL = 'gpt-5.1';
const MAX_PROFILE_CHARS = 4000;
const MAX_TRANSCRIPT_CHARS = 6000;

const parseList = v => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

// Owner ruling (2026-07-19): a profile is a synthesized portrait organized by
// dimensions, never a dated event log — the old "- [YYYY-MM-DD] entry" format
// grew into exactly that. Only Current-workstreams lines carry dates (they are
// genuinely time-bound); every other dimension holds distilled stable traits.
const RULES_ZH = `请输出更新后的完整画像。画像是对这个人的综合归纳，不是事件记录——把新信息提炼、融合进对应维度的已有表述，而不是按日期追加条目。

按以下维度组织（Markdown 小节，无内容的维度省略，不要输出一级大标题）：
### 角色与职责
### 工作主线
正在推进的事项，每条概括当前状态和所处阶段，句末标注最后确认日期（如"（07-19）"）；超过 30 天未再确认且明显不再进行的删除。
### 关注点与诉求
持续关心的方向、反复表达的诉求与优先级。
### 卡点模式
反复出现或长期存在的障碍；一次性卡点解决后即删除。
### 风格与习惯
工作节奏、沟通与表达方式、协作习惯。

要求：
- 用概括性表述："正在主导 X，处于联调阶段"，而不是"某天做了什么"；逐日流水不进画像。
- 新信息优先融合改写已有条目，被取代的旧表述删除。
- 除工作主线外，其他维度不带日期，只保留提炼后的稳定认识。
- 总长不超过 500 字。只输出画像本身，不要解释或多余文字。`;

const RULES_EN = `Output the full updated profile. A profile is a synthesized portrait of the person, not an event log — distill new information into the existing wording of the matching dimension instead of appending dated entries.

Organize into these dimensions (Markdown sections; omit empty ones; no top-level heading):
### Role & responsibilities
### Current workstreams
Items actively in progress — each line summarizes the current state and stage, ending with the last-confirmed date (e.g. "(07-19)"); drop items unconfirmed for over 30 days and clearly no longer active.
### Focus & asks
Directions they persistently care about, repeated asks and priorities.
### Blocker patterns
Recurring or long-standing obstacles; remove one-off blockers once resolved.
### Style & habits
Work rhythm, communication and collaboration style.

Requirements:
- Summarize, don't log: "leading X, now in integration testing", never "did Y on a given day"; day-by-day details stay out.
- Fold new information into existing entries first; delete superseded wording.
- Only Current workstreams carries dates — other dimensions hold distilled, stable observations.
- Keep the total under 350 words. Output only the profile itself — no explanation or extra text.`;

// The profile is written in the member's language: their reports arrive in it,
// and the profile is injected into the agent's instructions for that member's
// calls (mixed-language instructions degrade weaker realtime models).
const PROFILE_STRINGS = {
  zh: {
    sep: '：',
    none: '（无）',
    labels: { yesterday: '昨天', today: '今天计划', blockers: '卡点', topics: '日会待议', points: '要点', highlights: '重点信号' },
    introDaily: (name, today) => `你负责维护团队成员「${name}」的动态画像。画像是一份随日报持续演化的备忘，帮助语音日报助手理解这个人的工作上下文。今天是 ${today}。`,
    introTask: (name, today) => `你负责维护团队成员「${name}」的动态画像。画像是一份随沟通持续演化的备忘，帮助语音助手理解这个人的工作上下文。今天是 ${today}。`,
    baseCtx: ctx => `【人工填写的基础背景】（仅作参考，不要复制进画像）\n${ctx}`,
    existing: p => `【现有画像】\n${p}`,
    existingEmpty: `【现有画像】（还没有，今天是第一次生成）`,
    todayReport: body => `【今天的日报】\n${body}`,
    todayTask: (title, body) => `【今天的一对一沟通】主题：${title}\n${body}`,
    transcript: t => `【今天的原始对话】\n${t}`,
    rulesDaily: RULES_ZH,
    rulesTask: RULES_ZH,
  },
  en: {
    sep: ':',
    none: '(none)',
    labels: { yesterday: 'Yesterday', today: "Today's plan", blockers: 'Blockers', topics: 'Meeting topics', points: 'Key points', highlights: 'Key signals' },
    introDaily: (name, today) => `You maintain the dynamic profile of team member ${name}. The profile is a living memo that evolves with their daily reports, helping the voice standup assistant understand this person's work context. Today is ${today}.`,
    introTask: (name, today) => `You maintain the dynamic profile of team member ${name}. The profile is a living memo that evolves with their conversations, helping the voice assistant understand this person's work context. Today is ${today}.`,
    baseCtx: ctx => `[Human-written base context] (reference only — do not copy into the profile)\n${ctx}`,
    existing: p => `[Current profile]\n${p}`,
    existingEmpty: `[Current profile] (none yet — today is the first generation)`,
    todayReport: body => `[Today's report]\n${body}`,
    todayTask: (title, body) => `[Today's one-on-one] Topic: ${title}\n${body}`,
    transcript: t => `[Today's raw conversation]\n${t}`,
    rulesDaily: RULES_EN,
    rulesTask: RULES_EN,
  },
};

const section = (L, label, items) => items.length ? `${label}${L.sep}\n${items.map(i => `- ${i}`).join('\n')}` : `${label}${L.sep}${L.none}`;

export class ProfileUpdater {
  constructor(store, getConfig, env, settings) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env;       // { openaiApiKey, proxy }
    this.settings = settings; // textConnection('profile'): provider + key + model
  }

  /** Owner-written override of the default profile rules (agent_context KV), verbatim when set. */
  profileRules(defaultRules) {
    return (this.store.getContext('profile_instruction') || '').trim() || defaultRules;
  }

  buildPrompt(member, report, todayDate) {
    const L = PROFILE_STRINGS[this.settings.memberLanguage(member)] || PROFILE_STRINGS.zh;
    const existing = (member.profile || '').trim();
    const baseCtx = (member.context || '').trim();
    let transcript = (report.transcript || '').trim();
    if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;

    const body = [
      section(L, L.labels.yesterday, parseList(report.yesterday)),
      section(L, L.labels.today, parseList(report.today)),
      section(L, L.labels.blockers, parseList(report.blockers)),
      section(L, L.labels.topics, parseList(report.topics)),
    ].join('\n');
    return [
      L.introDaily(member.name, todayDate),
      baseCtx ? L.baseCtx(baseCtx) : null,
      existing ? L.existing(existing) : L.existingEmpty,
      L.todayReport(body),
      transcript ? L.transcript(transcript) : null,
      this.profileRules(L.rulesDaily),
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Merge a submitted report into the member's profile. Fire-and-forget from
   * the relay: never throws, returns true when the profile was updated.
   */
  async updateAfterReport(memberId, reportDate) {
    try {
      const member = this.store.getMemberById(memberId);
      if (!member || member.is_test) return false;
      const report = this.store.getReport(memberId, reportDate);
      if (!report || report.status !== 'submitted') return false;
      const conn = this.settings.textConnection('profile');
      if (!conn.key) return false;

      const prompt = this.buildPrompt(member, report, reportDate);
      const text = await this.callModel(conn, prompt, member.id);
      const profile = String(text || '').trim().slice(0, MAX_PROFILE_CHARS);
      if (!profile) return false;
      this.store.setMemberProfile(member.id, profile);
      console.log(`[rounds] profile updated for ${member.name} (${profile.length} chars)`);
      return true;
    } catch (err) {
      console.error(`[rounds] profile update failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Merge a submitted generic-task conversation (cycle record) into the
   * member's profile. Same contract as updateAfterReport: fire-and-forget,
   * never throws.
   */
  async updateAfterTaskSession(memberId, taskId, cycleKey) {
    try {
      const member = this.store.getMemberById(memberId);
      if (!member || member.is_test) return false;
      const task = this.store.getTask(taskId);
      const rec = this.store.getCycleRecord(taskId, memberId, cycleKey);
      if (!task || !rec || rec.status !== 'submitted') return false;
      const conn = this.settings.textConnection('profile');
      if (!conn.key) return false;

      const L = PROFILE_STRINGS[this.settings.memberLanguage(member)] || PROFILE_STRINGS.zh;
      const today = new Date().toLocaleDateString('sv', { timeZone: this.settings.resolveTimeZone() });
      let transcript = (rec.transcript || '').trim();
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
      const body = [
        section(L, L.labels.points, parseList(rec.summary)),
        section(L, L.labels.highlights, parseList(rec.highlights)),
      ].join('\n');
      const prompt = [
        L.introTask(member.name, today),
        (member.context || '').trim() ? L.baseCtx(member.context.trim()) : null,
        (member.profile || '').trim() ? L.existing(member.profile.trim()) : L.existingEmpty,
        L.todayTask(task.title, body),
        transcript ? L.transcript(transcript) : null,
        this.profileRules(L.rulesTask),
      ].filter(Boolean).join('\n\n');

      const text = await this.callModel(conn, prompt, member.id);
      const profile = String(text || '').trim().slice(0, MAX_PROFILE_CHARS);
      if (!profile) return false;
      this.store.setMemberProfile(member.id, profile);
      console.log(`[rounds] profile updated for ${member.name} after task #${taskId} (${profile.length} chars)`);
      return true;
    } catch (err) {
      console.error(`[rounds] profile update (task) failed: ${err.message}`);
      return false;
    }
  }

  /** One chat-completions call on the profile slot's resolved connection. */
  callModel(conn, prompt, memberId = null) {
    return callChatModel({
      base: conn.base,
      model: conn.model,
      key: conn.key,
      prompt,
      proxy: this.env.proxy,
      onUsage: usage => recordTextUsage(this.store, {
        slot: 'profile', provider: conn.provider, model: conn.model,
        memberId, tz: this.settings.resolveTimeZone(), usage,
      }),
    });
  }
}

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
    rulesDaily: `请输出更新后的完整画像，要求：
- 内容围绕：角色/职责、在做的项目及进展脉络、持续的关注点、反复出现的卡点、工作习惯，以及对话中透露的其他有助于沟通的信息。
- 每条一行，以"- [YYYY-MM-DD]"开头，日期是该信息最后一次被确认的日期；今天日报里再次出现的旧信息，把日期更新为今天并合并表述。
- 超过 30 天没有再出现、且已明显不再相关的条目删除；被新信息取代的旧表述删除。
- 逐日的流水账（具体某天做了什么）不要进画像，画像只保留跨天有意义的脉络和事实。
- 总长不超过 500 字。只输出画像条目本身，不要任何解释、标题或多余文字。`,
    rulesTask: `请输出更新后的完整画像，要求：
- 内容围绕：角色/职责、在做的项目及进展脉络、持续的关注点、反复出现的卡点、工作习惯，以及对话中透露的其他有助于沟通的信息。
- 每条一行，以"- [YYYY-MM-DD]"开头，日期是该信息最后一次被确认的日期；这次沟通里再次出现的旧信息，把日期更新为今天并合并表述。
- 超过 30 天没有再出现、且已明显不再相关的条目删除；被新信息取代的旧表述删除。
- 逐次沟通的流水账不要进画像，画像只保留跨天有意义的脉络和事实。
- 总长不超过 500 字。只输出画像条目本身，不要任何解释、标题或多余文字。`,
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
    rulesDaily: `Output the full updated profile, with these requirements:
- Content should cover: role/responsibilities, ongoing projects and their progress threads, persistent focus areas, recurring blockers, work habits, and anything else revealed in conversation that helps communication.
- One entry per line, starting with "- [YYYY-MM-DD]" — the date the information was last confirmed; for old information that reappears in today's report, update its date to today and merge the wording.
- Delete entries not seen for over 30 days that are clearly no longer relevant; delete old wording superseded by new information.
- Day-by-day logs (what was done on a specific day) do not belong in the profile — keep only threads and facts meaningful across days.
- Keep the total under 350 words. Output only the profile entries themselves — no explanation, headings or extra text.`,
    rulesTask: `Output the full updated profile, with these requirements:
- Content should cover: role/responsibilities, ongoing projects and their progress threads, persistent focus areas, recurring blockers, work habits, and anything else revealed in conversation that helps communication.
- One entry per line, starting with "- [YYYY-MM-DD]" — the date the information was last confirmed; for old information that reappears in this conversation, update its date to today and merge the wording.
- Delete entries not seen for over 30 days that are clearly no longer relevant; delete old wording superseded by new information.
- Per-conversation logs do not belong in the profile — keep only threads and facts meaningful across days.
- Keep the total under 350 words. Output only the profile entries themselves — no explanation, headings or extra text.`,
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
      L.rulesDaily,
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
        L.rulesTask,
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

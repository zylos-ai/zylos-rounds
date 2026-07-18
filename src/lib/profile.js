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

const section = (label, items) => items.length ? `${label}：\n${items.map(i => `- ${i}`).join('\n')}` : `${label}：（无）`;

export class ProfileUpdater {
  constructor(store, getConfig, env, settings) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env;       // { openaiApiKey, proxy }
    this.settings = settings; // resolveKey(): env > DB > none
  }

  buildPrompt(member, report, todayDate) {
    const existing = (member.profile || '').trim();
    const baseCtx = (member.context || '').trim();
    let transcript = (report.transcript || '').trim();
    if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;

    return [
      `你负责维护团队成员「${member.name}」的动态画像。画像是一份随日报持续演化的备忘，帮助语音日报助手理解这个人的工作上下文。今天是 ${todayDate}。`,
      baseCtx ? `【人工填写的基础背景】（仅作参考，不要复制进画像）\n${baseCtx}` : null,
      existing ? `【现有画像】\n${existing}` : `【现有画像】（还没有，今天是第一次生成）`,
      `【今天的日报】\n${section('昨天', parseList(report.yesterday))}\n${section('今天计划', parseList(report.today))}\n${section('卡点', parseList(report.blockers))}\n${section('日会待议', parseList(report.topics))}`,
      transcript ? `【今天的原始对话】\n${transcript}` : null,
      `请输出更新后的完整画像，要求：
- 内容围绕：角色/职责、在做的项目及进展脉络、持续的关注点、反复出现的卡点、工作习惯，以及对话中透露的其他有助于沟通的信息。
- 每条一行，以"- [YYYY-MM-DD]"开头，日期是该信息最后一次被确认的日期；今天日报里再次出现的旧信息，把日期更新为今天并合并表述。
- 超过 30 天没有再出现、且已明显不再相关的条目删除；被新信息取代的旧表述删除。
- 逐日的流水账（具体某天做了什么）不要进画像，画像只保留跨天有意义的脉络和事实。
- 总长不超过 500 字。只输出画像条目本身，不要任何解释、标题或多余文字。`,
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
      const key = this.settings.resolveKey();
      if (!key) return false;

      const prompt = this.buildPrompt(member, report, reportDate);
      const text = await this.callModel(key, prompt);
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
      const key = this.settings.resolveKey();
      if (!key) return false;

      const today = new Date().toLocaleDateString('sv', { timeZone: this.getConfig().timeZone || 'Asia/Shanghai' });
      let transcript = (rec.transcript || '').trim();
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
      const prompt = [
        `你负责维护团队成员「${member.name}」的动态画像。画像是一份随沟通持续演化的备忘，帮助语音助手理解这个人的工作上下文。今天是 ${today}。`,
        (member.context || '').trim() ? `【人工填写的基础背景】（仅作参考，不要复制进画像）\n${member.context.trim()}` : null,
        (member.profile || '').trim() ? `【现有画像】\n${member.profile.trim()}` : `【现有画像】（还没有，今天是第一次生成）`,
        `【今天的一对一沟通】主题：${task.title}\n${section('要点', parseList(rec.summary))}\n${section('重点信号', parseList(rec.highlights))}`,
        transcript ? `【今天的原始对话】\n${transcript}` : null,
        `请输出更新后的完整画像，要求：
- 内容围绕：角色/职责、在做的项目及进展脉络、持续的关注点、反复出现的卡点、工作习惯，以及对话中透露的其他有助于沟通的信息。
- 每条一行，以"- [YYYY-MM-DD]"开头，日期是该信息最后一次被确认的日期；这次沟通里再次出现的旧信息，把日期更新为今天并合并表述。
- 超过 30 天没有再出现、且已明显不再相关的条目删除；被新信息取代的旧表述删除。
- 逐次沟通的流水账不要进画像，画像只保留跨天有意义的脉络和事实。
- 总长不超过 500 字。只输出画像条目本身，不要任何解释、标题或多余文字。`,
      ].filter(Boolean).join('\n\n');

      const text = await this.callModel(key, prompt);
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

  /** One chat-completions call. profileApiBase override exists for E2E mocks. */
  callModel(key, prompt) {
    return callChatModel({
      base: this.getConfig().profileApiBase,
      model: this.settings.resolveProfileModel(),
      key,
      prompt,
      proxy: this.env.proxy,
    });
  }
}

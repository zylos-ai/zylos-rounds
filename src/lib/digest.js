/**
 * Task-level digests (任务汇总).
 *
 * Owner rulings (2026-07-18):
 *   - oneshot tasks: manual trigger by default, optional scheduled
 *     `digest_auto_at`, close linkage decoupled, re-trigger overwrites.
 *     Digest stored on the task row.
 *   - recurring tasks: one digest per cycle, auto-generated when the cycle
 *     ends (manual trigger works any time and overwrites). Stored in
 *     cycle_digests. The built-in daily standup is excluded — its per-day
 *     view aggregates live from `reports`.
 *   - the digest *instruction* is customizable per task
 *     (`digest_instruction`); when unset, a per-type default template applies.
 */

import { callChatModel } from './llm.js';
import { recordTextUsage } from './pricing.js';
import { ONESHOT_CYCLE, currentCycleKey, previousCycleKey } from './cycle.js';
import { todayLocal } from './http-util.js';

const MAX_TRANSCRIPT_TAIL = 2000;

// Digests are owner-facing, so all prompt scaffolding follows the TEAM default
// language (per-member language only affects the member's own conversation).
// A custom digest_instruction is used verbatim in whatever language it's in.
const DIGEST_STRINGS = {
  zh: {
    oneshot: `请输出给负责人看的汇总报告（Markdown），结构：
## 共识
成员间观点一致或方向相同的点，合并表述，标注支持的人。
## 分歧
观点不一致的点，逐条列出各方立场和归属。
## 重点信号
值得负责人单独注意的信息：强烈诉求、风险、情绪、超出问题框架但重要的内容，标注来源成员。`,
    recurring: `请输出给负责人看的本周期汇总报告（Markdown），结构：
## 进展要点
按成员归并本周期的关键进展和结论，标注归属。
## 共性主题
多位成员都提到的主题、模式或问题，合并表述。
## 重点信号
值得负责人单独注意的信息：风险、强烈诉求、情绪、需要负责人介入的点，标注来源成员。`,
    sharedRules: '要求：只依据上面提供的内容，不要编造；未完成对话的成员在结尾单独列出名单；语言简洁，直接给结论。',
    notSubmitted: '（未完成对话）',
    points: '要点：',
    highlights: '重点信号：',
    excerpt: '对话摘录：',
    empty: '（无内容）',
    secYesterday: '昨天',
    secToday: '今天',
    secBlockers: '卡点',
    secTopics: '待议',
    intro: '你替团队负责人整理一轮一对一沟通的汇总报告。负责人委托语音助手就同一主题分别与多位成员沟通，下面是每个人的沟通结果。',
    task: '【任务】',
    cycle: key => `【周期】${key} 起始的这一期`,
    brief: '【任务背景】',
    questions: '【问题框架】',
    results: '【各成员的沟通结果】',
  },
  en: {
    oneshot: `Write the summary report for the team lead (Markdown), structured as:
## Consensus
Points where members agree or point the same way — merge them and note who supports each.
## Disagreements
Points of disagreement — list each side's position and who holds it.
## Key signals
Information the lead should note individually: strong asks, risks, emotions, important content beyond the question frame — attribute each to its member.`,
    recurring: `Write this cycle's summary report for the team lead (Markdown), structured as:
## Progress highlights
Key progress and conclusions this cycle, grouped by member with attribution.
## Common themes
Topics, patterns or problems multiple members raised — merge them.
## Key signals
Information the lead should note individually: risks, strong asks, emotions, points needing the lead's involvement — attribute each to its member.`,
    sharedRules: 'Requirements: base everything strictly on the content above, never invent; list members who did not complete their conversation separately at the end; be concise and lead with conclusions.',
    notSubmitted: ' (conversation not completed)',
    points: 'Key points:',
    highlights: 'Key signals:',
    excerpt: 'Transcript excerpt:',
    empty: '(no content)',
    secYesterday: 'Yesterday',
    secToday: 'Today',
    secBlockers: 'Blockers',
    secTopics: 'Meeting topics',
    intro: "You compile a summary report for the team lead. The lead delegated a voice assistant to talk with several members one-on-one about the same topic; below are each member's results.",
    task: '[Task] ',
    cycle: key => `[Cycle] the round starting ${key}`,
    brief: '[Task background]',
    questions: '[Question frame]',
    results: "[Each member's results]",
  },
};

const parseList = v => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

export class DigestGenerator {
  constructor(store, getConfig, env, settings) {
    this.store = store;
    this.getConfig = getConfig;
    this.env = env;
    this.settings = settings;
    this.timer = null;
  }

  /**
   * The built-in daily task stores data in `reports` (structured
   * yesterday/today/blockers/topics), not cycle_records — adapt one day's
   * reports (plus the not-yet-reported roster) to the buildPrompt row shape.
   */
  dailyRows(date) {
    const L = DIGEST_STRINGS[this.settings.resolveLanguage()] || DIGEST_STRINGS.zh;
    const reports = this.store.dayReports(date);
    const done = new Set(reports.map(r => r.member_id));
    return [
      ...reports.map(r => ({
        name: r.name,
        status: 'submitted',
        summary: JSON.stringify([
          ...parseList(r.yesterday).map(s => `[${L.secYesterday}] ${s}`),
          ...parseList(r.today).map(s => `[${L.secToday}] ${s}`),
          ...parseList(r.blockers).map(s => `[${L.secBlockers}] ${s}`),
        ]),
        highlights: JSON.stringify(parseList(r.topics).map(s => `[${L.secTopics}] ${s}`)),
        transcript: r.transcript || '',
      })),
      ...this.store.listActiveMembers().filter(m => !done.has(m.id))
        .map(m => ({ name: m.name, status: 'pending', summary: '[]', highlights: '[]', transcript: '' })),
    ];
  }

  buildPrompt(task, rows, cycleKey) {
    const L = DIGEST_STRINGS[this.settings.resolveLanguage()] || DIGEST_STRINGS.zh;
    const sections = rows.map(r => {
      const parts = [`### ${r.name}${r.status === 'submitted' ? '' : L.notSubmitted}`];
      const summary = parseList(r.summary);
      const highlights = parseList(r.highlights);
      if (summary.length) parts.push(`${L.points}\n${summary.map(s => `- ${s}`).join('\n')}`);
      if (highlights.length) parts.push(`${L.highlights}\n${highlights.map(s => `- ${s}`).join('\n')}`);
      let t = (r.transcript || '').trim();
      if (t) {
        if (t.length > MAX_TRANSCRIPT_TAIL) t = `…${t.slice(-MAX_TRANSCRIPT_TAIL)}`;
        parts.push(`${L.excerpt}\n${t}`);
      }
      if (parts.length === 1) parts.push(L.empty);
      return parts.join('\n');
    });

    const custom = (task.digest_instruction || '').trim();
    const instruction = custom || (task.type === 'recurring' ? L.recurring : L.oneshot);
    const cycleLine = task.type === 'recurring' && cycleKey && cycleKey !== ONESHOT_CYCLE
      ? L.cycle(cycleKey) : null;

    return [
      L.intro,
      `${L.task}${task.title}`,
      cycleLine,
      (task.brief || '').trim() ? `${L.brief}\n${task.brief.trim()}` : null,
      (task.questions || '').trim() ? `${L.questions}\n${task.questions.trim()}` : null,
      `${L.results}\n${sections.join('\n\n')}`,
      `${instruction}\n${L.sharedRules}`,
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Generate (or re-generate) a digest. For oneshot tasks the cycle is fixed
   * ('-') and the result lands on the task row; for recurring tasks it lands
   * on cycle_digests[cycleKey]. Returns the digest text, or null when it
   * can't run (no key / no task / nothing submitted for that cycle).
   */
  async generate(taskId, cycleKey = null) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const key = cycleKey ?? (task.type === 'oneshot'
      ? ONESHOT_CYCLE
      : currentCycleKey(task, todayLocal(this.settings.resolveTimeZone())));
    if (!key) return null;
    const rows = task.is_builtin ? this.dailyRows(key) : this.store.cycleRecords(taskId, key);
    if (!rows.some(r => r.status === 'submitted')) return null;
    const conn = this.settings.textConnection('digest');
    if (!conn.key) return null;

    const text = await callChatModel({
      base: conn.base,
      model: conn.model,
      key: conn.key,
      prompt: this.buildPrompt(task, rows, key),
      proxy: this.env.proxy,
      timeoutMs: 120_000,
      onUsage: usage => recordTextUsage(this.store, {
        slot: 'digest', provider: conn.provider, model: conn.model,
        tz: this.settings.resolveTimeZone(), usage,
      }),
    });
    const digest = String(text || '').trim();
    if (!digest) return null;
    if (task.type === 'oneshot') this.store.setTaskDigest(taskId, digest);
    else this.store.setCycleDigest(taskId, key, digest);
    console.log(`[rounds] digest generated for task #${taskId} cycle ${key} (${digest.length} chars)`);
    return digest;
  }

  /** Manual or scheduled trigger; applies the oneshot close linkage when configured. */
  async trigger(taskId, { close, cycleKey } = {}) {
    const digest = await this.generate(taskId, cycleKey ?? null);
    if (digest === null) return { ok: false, error: 'nothing_to_digest' };
    const task = this.store.getTask(taskId);
    if (task.type === 'oneshot') {
      const shouldClose = close ?? Boolean(task.digest_close_linked);
      if (shouldClose && task.status === 'open') this.store.setTaskStatus(taskId, 'closed');
      return { ok: true, digest, closed: shouldClose };
    }
    return { ok: true, digest, closed: false };
  }

  /** Minute-level scheduler: oneshot digest_auto_at + recurring cycle-end digests. */
  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDue().catch(e => console.error('[rounds] auto digest error', e.message)), 60_000);
    this.timer.unref();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runDue() {
    const tz = this.settings.resolveTimeZone();
    const now = new Date().toLocaleString('sv', { timeZone: tz }).replace(' ', 'T');
    for (const task of this.store.dueAutoDigestTasks(now)) {
      // fired even when generation is skipped (nothing submitted) — an empty
      // round shouldn't retry every minute forever; manual trigger still works
      this.store.markTaskAutoFired(task.id);
      console.log(`[rounds] auto digest firing for task #${task.id} ${task.title}`);
      await this.trigger(task.id);
    }

    // Recurring cycle-end digests (owner Q2 ruling): when the previous cycle
    // has ended and never had a digest attempt, fire once. Rows with
    // auto_fired=1 and no content mark "attempted, nothing to digest" so an
    // empty cycle doesn't retry every minute; a manual trigger still works.
    const today = todayLocal(tz);
    for (const task of this.store.openRecurringTasks()) {
      const prev = previousCycleKey(task, today);
      if (!prev) continue;
      const existing = this.store.getCycleDigest(task.id, prev);
      if (existing) continue;
      console.log(`[rounds] cycle-end digest firing for task #${task.id} cycle ${prev}`);
      await this.generate(task.id, prev); // stores content when there is any
      this.store.setCycleDigest(task.id, prev, null, { autoFired: true });
    }
  }
}

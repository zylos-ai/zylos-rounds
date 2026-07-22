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
值得负责人单独注意的信息：强烈诉求、风险、情绪、超出问题框架但重要的内容，标注来源成员。
未完成对话的成员，在结尾单独用一行列出名单。`,
    recurring: `请输出给负责人看的本周期汇总报告（Markdown）。这份报告要能直接在日会上展示：最上面放"总览"和"待议"——开会时念这两段就够；其余为补充和明细，供按需查阅。视角要求：以事为中心组织内容，不要按成员逐人罗列——同一事项涉及多人时合并到一起讲，人名只在句中做归属标注（如"（张三）"）。不要输出一级大标题（#），直接从下面的小节开始，严格按此顺序：
## 总览
3 行以内概括全局：提交率（X/Y 人）、今日核心推进方向（2-3 个关键词）、主要风险（1-2 个）。如果有成员未提交或内容为空，在这里用一行列出他们的名字。
## 待议
这是日会唯一的议程，也是这份报告的核心。把所有"需要在日会上讨论、对齐或由负责人拍板"的事项合并成一份去重的清单，逐条列出，每条写清楚要拍板/对齐什么 + 涉及谁。来源有三类，合并去重、同一件事只列一条、不要按来源分小标题：① 成员主动提出的议题；② 卡点中需要多方拉通或需要负责人拍板的（点对点就能解决的卡点不必进这里）；③ 下面「依赖比对」发现的、需要拉齐的断裂依赖或风险。如果没有需要上会的事项，写"无"。

---
*以下为补充与明细，供按需查阅（开会不必逐条念）。*
## 卡点与风险
本周期所有受阻事项和潜在风险的完整清单，按事项列出：问题·影响·归属。只列真正阻塞或有风险的。已经进入「待议」的事项，这里只用一句话点到即可，不再重复展开。
## 依赖比对
交叉比对所有成员的信息的原始发现，检查并列出：成员 A 的工作依赖成员 B 做某事但 B 没有提到这件事（依赖断裂）；某项工作有时间压力但上游未就绪（风险升级）；多人在做类似的事但没有提到协作（可能重复）。已进入「待议」的，这里一句话点到即可。如果没有发现问题，写"未发现依赖断裂"。
## 已完成
成员明确说已完成/已交付/已上线/已发版的事项。按事项归并，标注归属。如果没有任何明确完成的事项，写"无明确完成事项"。
## 进行中
成员提到但尚未完成的事项，标注进度（如果成员提了进度或预计完成时间，一并写上）。按事项归并，标注归属。注意：成员提到"在做某事"不等于"完成了某事"，未明确说完成的一律放这里。
## 计划
本周期计划做的事项，按事项归并，标注归属。`,
    sharedRules: '要求：只依据上面提供的内容，不要编造；语言简洁，直接给结论。',
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
    priorFollowups: '【近期补充与跟进（含已拍板结论）】',
    priorFollowupsRule: '注意：以下是最近就相关工作补充或更新的信息，其中已经明确或拍板的部分不要再列入「待议」议程；如本轮内容仍与之相关，只在对应明细小节（如「进行中」「已完成」）里用一句话交代结论或后续进展即可。',
  },
  en: {
    oneshot: `Write the summary report for the team lead (Markdown), structured as:
## Consensus
Points where members agree or point the same way — merge them and note who supports each.
## Disagreements
Points of disagreement — list each side's position and who holds it.
## Key signals
Information the lead should note individually: strong asks, risks, emotions, important content beyond the question frame — attribute each to its member.
List members who did not complete their conversation on a single line at the end.`,
    recurring: `Write this cycle's summary report for the team lead (Markdown). This report is meant to be shown at the daily meeting: put "Overview" and "For discussion" at the very top — reading out those two is enough for the meeting; everything else is supporting material and detail for lookup on demand. Perspective: organize by workstream/topic, never member by member — when several members touch the same item, merge their input into one place and use names only as inline attribution (e.g. "(Alex)"). Do not emit a top-level heading (#); start directly with these sections, in exactly this order:
## Overview
Sum up the whole cycle in 3 lines or fewer: submission rate (X/Y members), today's core workstreams (2-3 keywords), main risks (1-2). If any member did not submit or their content is empty, list their names here on one line.
## For discussion
This is the meeting's only agenda and the core of the report. Merge everything that "needs to be discussed, aligned on, or decided by the lead at the meeting" into a single de-duplicated list; for each, state clearly what to decide/align on + who is involved. It draws from three sources — merge and de-duplicate them, list each item only once, and do NOT split by source into sub-headings: (1) topics members raised themselves; (2) blockers that need multi-party alignment or a decision from the lead (point-to-point-solvable blockers do not belong here); (3) dependency gaps or risks surfaced by the "Dependency check" below that need alignment. If there is nothing for the meeting, write "None."

---
*Supporting material and detail below — for lookup as needed (no need to read out at the meeting).*
## Blockers & risks
The complete list of stalled items and potential risks this cycle, by item: problem · impact · owner. Only list what is genuinely blocked or at risk. For anything already in "For discussion", just note it in one line here — do not re-expand it.
## Dependency check
The raw cross-reference findings across all members' input: member A depends on member B for something but B did not mention it (dependency gap); an item has a deadline but its upstream is not ready (escalated risk); multiple members are working on similar things without mentioning coordination (possible duplication). For anything already in "For discussion", note it in one line here. If no issues found, write "No dependency gaps detected."
## Completed
Items members explicitly said are done/shipped/deployed/released. Group by workstream with attribution. If nothing was explicitly completed, write "No items explicitly completed."
## In progress
Items members mentioned but have not completed — include progress estimates or ETAs if the member provided them. Group by workstream with attribution. Note: "working on X" does not mean "finished X"; anything not explicitly completed goes here.
## Planned
Items planned for this cycle, grouped by workstream with attribution.`,
    sharedRules: 'Requirements: base everything strictly on the content above, never invent; be concise and lead with conclusions.',
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
    priorFollowups: '[Recent follow-ups (settled decisions included)]',
    priorFollowupsRule: 'Note: the items below are recently appended or updated information — do NOT list anything already settled or decided under "For discussion" again; if this round still relates to them, just note the outcome or follow-up progress in one line under the relevant detail section (e.g. "In progress" / "Completed").',
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
      ...this.store.dailyRosterMembers().filter(m => !done.has(m.id))
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

    // Follow-up closeout — feed in follow-ups appended since the previous
    // active cycle (补充/跟进/更新, settled decisions included) so the model
    // closes them out instead of re-surfacing them from stale reports. Applies
    // to every task; visibility is scope-filtered by the task's audience (see
    // Store.recentFollowups). No prior active cycle → legacy rolling window.
    let followupsBlock = null;
    const fuSince = cycleKey && cycleKey !== ONESHOT_CYCLE
      ? this.store.taskFollowupAnchor?.(task, cycleKey) : null;
    const followups = this.store.recentFollowups?.(task.id, task.audience || 'internal', { since: fuSince }) || [];
    if (followups.length) {
      followupsBlock = `${L.priorFollowups}\n${L.priorFollowupsRule}\n`
        + followups.map(f => `- ${(f.content || '').trim()}`).join('\n');
    }

    return [
      L.intro,
      `${L.task}${task.title}`,
      cycleLine,
      (task.brief || '').trim() ? `${L.brief}\n${task.brief.trim()}` : null,
      (task.questions || '').trim() ? `${L.questions}\n${task.questions.trim()}` : null,
      `${L.results}\n${sections.join('\n\n')}`,
      followupsBlock,
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
      authType: conn.authType,
      getAuth: conn.getAuth,
      prompt: this.buildPrompt(task, rows, key),
      proxy: this.env.proxy,
      timeoutMs: 120_000,
      attempts: 3, // auto-retry transient proxy/network hiccups (idempotent overwrite)
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

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
import { ONESHOT_CYCLE, currentCycleKey, previousCycleKey } from './cycle.js';
import { todayLocal } from './http-util.js';

const MAX_TRANSCRIPT_TAIL = 2000;

const DEFAULT_ONESHOT_INSTRUCTION = `请输出给负责人看的汇总报告（Markdown），结构：
## 共识
成员间观点一致或方向相同的点，合并表述，标注支持的人。
## 分歧
观点不一致的点，逐条列出各方立场和归属。
## 重点信号
值得负责人单独注意的信息：强烈诉求、风险、情绪、超出问题框架但重要的内容，标注来源成员。`;

const DEFAULT_RECURRING_INSTRUCTION = `请输出给负责人看的本周期汇总报告（Markdown），结构：
## 进展要点
按成员归并本周期的关键进展和结论，标注归属。
## 共性主题
多位成员都提到的主题、模式或问题，合并表述。
## 重点信号
值得负责人单独注意的信息：风险、强烈诉求、情绪、需要负责人介入的点，标注来源成员。`;

const SHARED_RULES = '要求：只依据上面提供的内容，不要编造；未完成对话的成员在结尾单独列出名单；语言简洁，直接给结论。';

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

  buildPrompt(task, rows, cycleKey) {
    const sections = rows.map(r => {
      const parts = [`### ${r.name}${r.status === 'submitted' ? '' : '（未完成对话）'}`];
      const summary = parseList(r.summary);
      const highlights = parseList(r.highlights);
      if (summary.length) parts.push(`要点：\n${summary.map(s => `- ${s}`).join('\n')}`);
      if (highlights.length) parts.push(`重点信号：\n${highlights.map(s => `- ${s}`).join('\n')}`);
      let t = (r.transcript || '').trim();
      if (t) {
        if (t.length > MAX_TRANSCRIPT_TAIL) t = `…${t.slice(-MAX_TRANSCRIPT_TAIL)}`;
        parts.push(`对话摘录：\n${t}`);
      }
      if (parts.length === 1) parts.push('（无内容）');
      return parts.join('\n');
    });

    const custom = (task.digest_instruction || '').trim();
    const instruction = custom || (task.type === 'recurring' ? DEFAULT_RECURRING_INSTRUCTION : DEFAULT_ONESHOT_INSTRUCTION);
    const cycleLine = task.type === 'recurring' && cycleKey && cycleKey !== ONESHOT_CYCLE
      ? `【周期】${cycleKey} 起始的这一期` : null;

    return [
      `你替团队负责人整理一轮一对一沟通的汇总报告。负责人委托语音助手就同一主题分别与多位成员沟通，下面是每个人的沟通结果。`,
      `【任务】${task.title}`,
      cycleLine,
      (task.brief || '').trim() ? `【任务背景】\n${task.brief.trim()}` : null,
      (task.questions || '').trim() ? `【问题框架】\n${task.questions.trim()}` : null,
      `【各成员的沟通结果】\n${sections.join('\n\n')}`,
      `${instruction}\n${SHARED_RULES}`,
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
    if (!task || task.is_builtin) return null;
    const key = cycleKey ?? (task.type === 'oneshot'
      ? ONESHOT_CYCLE
      : currentCycleKey(task, todayLocal(this.getConfig().timeZone)));
    if (!key) return null;
    const rows = this.store.cycleRecords(taskId, key);
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
    const tz = this.getConfig().timeZone || 'Asia/Shanghai';
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

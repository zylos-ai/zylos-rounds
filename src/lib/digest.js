/**
 * Task-level digest (任务汇总) for oneshot communication tasks.
 *
 * Owner's 2026-07-18 ruling: triggering is configurable — manual by default
 * (an admin/API action), optionally scheduled via `digest_auto_at`; whether a
 * trigger also closes the task is a separate flag (`digest_close_linked`);
 * re-triggering overwrites the previous digest.
 *
 * The digest synthesizes all submitted per-member summaries (plus transcript
 * tails) into 共识 / 分歧 / 重点信号 — the report the owner reads before
 * pulling the team together.
 */

import { callChatModel } from './llm.js';
import { DEFAULT_PROFILE_MODEL } from './profile.js';

const MAX_TRANSCRIPT_TAIL = 2000;

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

  buildPrompt(task, rows) {
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

    return [
      `你替团队负责人整理一轮一对一沟通的汇总报告。负责人委托语音助手就同一主题分别与多位成员沟通，下面是每个人的沟通结果。`,
      `【任务】${task.title}`,
      (task.brief || '').trim() ? `【任务背景】\n${task.brief.trim()}` : null,
      (task.questions || '').trim() ? `【问题框架】\n${task.questions.trim()}` : null,
      `【各成员的沟通结果】\n${sections.join('\n\n')}`,
      `请输出给负责人看的汇总报告（Markdown），结构：
## 共识
成员间观点一致或方向相同的点，合并表述，标注支持的人。
## 分歧
观点不一致的点，逐条列出各方立场和归属。
## 重点信号
值得负责人单独注意的信息：强烈诉求、风险、情绪、超出问题框架但重要的内容，标注来源成员。
要求：只依据上面提供的内容，不要编造；未完成对话的成员在结尾单独列出名单；语言简洁，直接给结论。`,
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Generate (or re-generate) the digest for an oneshot task. Overwrites the
   * previous digest. Returns the digest text, or null when it can't run
   * (no key / no task / nothing submitted yet).
   */
  async generate(taskId) {
    const task = this.store.getTask(taskId);
    if (!task || task.type !== 'oneshot') return null;
    const rows = this.store.taskMembers(taskId);
    if (!rows.some(r => r.status === 'submitted')) return null;
    const key = this.settings.resolveKey();
    if (!key) return null;

    const cfg = this.getConfig();
    const text = await callChatModel({
      base: cfg.profileApiBase,
      model: cfg.digestModel || cfg.profileModel || DEFAULT_PROFILE_MODEL,
      key,
      prompt: this.buildPrompt(task, rows),
      proxy: this.env.proxy,
      timeoutMs: 120_000,
    });
    const digest = String(text || '').trim();
    if (!digest) return null;
    this.store.setTaskDigest(taskId, digest);
    console.log(`[rounds] digest generated for task #${taskId} (${digest.length} chars)`);
    return digest;
  }

  /** Manual or scheduled trigger; applies the close linkage when configured. */
  async trigger(taskId, { close } = {}) {
    const digest = await this.generate(taskId);
    if (digest === null) return { ok: false, error: 'nothing_to_digest' };
    const task = this.store.getTask(taskId);
    const shouldClose = close ?? Boolean(task.digest_close_linked);
    if (shouldClose && task.status === 'open') this.store.setTaskStatus(taskId, 'closed');
    return { ok: true, digest, closed: shouldClose };
  }

  /** Minute-level scheduler for digest_auto_at (local-time ISO minutes). */
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
  }
}

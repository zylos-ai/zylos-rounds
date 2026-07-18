/**
 * The agent's "brain" — the maintainable context that shapes every standup.
 *
 * Two faculties:
 *   1. Push (always injected): editable background containers composed into the
 *      realtime agent's instructions every session —
 *        - team_background   : what the team does, current priorities
 *        - probing_guidance  : when / what / how-deep to follow up
 *        - member.context    : per-person role + focus (stored on members row)
 *   2. Pull (on demand): the relay exposes recall_member_history and
 *      search_team_knowledge tools; this module formats their results.
 *
 * Everything here is data maintained by Luna / the coco avatar (management API)
 * or a human (admin UI) — tune it after each conversation and the agent gets
 * sharper. That feedback loop is the whole point ("越用越称手").
 */

export const CONTEXT_KEYS = ['team_background', 'probing_guidance'];

// Seeded once on first start so the mechanism is useful out of the box and
// self-documents how to write good guidance. team_background is left empty on
// purpose — real team context is filled in by Luna / the avatar.
export const DEFAULT_PROBING_GUIDANCE = `按这里的指引决定要不要追问、追问什么。没有命中的点就不要硬追，保持自然简短。

- 当对方说某件事"差不多做完/基本完成"时，追问一句是否已经验证过、怎么验证的。
- 当对方提到卡点或风险时，追问一句需要谁配合、卡了多久，帮他把待议题说清楚。
- 当对方今天的计划和昨天说的明显不一样时，可以轻轻问一句原因（必要时用 recall_member_history 看看上次说了什么）。
- 对方已经说得很具体，就不要为了追问而追问。`;

export class AgentContext {
  constructor(store) {
    this.store = store;
  }

  /** Fill in defaults for containers that have never been set. Idempotent. */
  seedDefaults() {
    if (this.store.getContext('probing_guidance') === null) {
      this.store.setContext('probing_guidance', DEFAULT_PROBING_GUIDANCE);
    }
    if (this.store.getContext('team_background') === null) {
      this.store.setContext('team_background', '');
    }
  }

  background() { return (this.store.getContext('team_background') || '').trim(); }
  probing() { return (this.store.getContext('probing_guidance') || '').trim(); }

  /**
   * Compose the realtime session instructions for one member. The base persona,
   * flow and safety rules are constant; the three background containers are
   * appended only when non-empty so an unconfigured install stays clean.
   *
   * `task` selects the conversation frame: the built-in daily standup keeps
   * its four-bucket flow; every other task (oneshot or custom recurring)
   * swaps in its own brief + question frame (both free text — content drives
   * behaviour, not code). Custom recurring tasks add a "this round" framing
   * so members understand it repeats.
   */
  buildInstructions(member, task = null) {
    const name = member.name;
    const generic = task && !task.is_builtin;
    const recurring = generic && task.type === 'recurring';
    const parts = generic ? [
      recurring
        ? `你是 Luna，代表团队负责人和同事「${name}」就「${task.title}」做本期的一对一语音沟通（这是一个定期进行的沟通任务）。全程说中文，口语自然、简短友好。`
        : `你是 Luna，代表团队负责人和同事「${name}」做一次一对一语音沟通，主题是「${task.title}」。全程说中文，口语自然、简短友好。`,
      `流程：先简单打招呼并说明这次想聊的主题，然后按下面的任务背景和问题框架逐个展开。一次只问一个问题，对方明显说完了再进入下一个；听到值得深入的点可以自然追问。整个对话控制在十分钟以内。`,
    ] : [
      `你是团队的日报助手 Luna，正在和同事「${name}」做每日语音汇报，全程说中文，口语自然、简短友好。`,
      `流程：先简单打个招呼，然后依次了解四件事：1) 昨天做了什么；2) 今天准备做什么；3) 有什么卡点或风险；4) 有什么问题需要在今天日会上讨论。一次只问一个问题，对方明显说完了就进入下一题，整个对话控制在五分钟以内。`,
    ];

    if (generic) {
      const brief = (task.brief || '').trim();
      if (brief) parts.push(`【任务背景】（负责人给你的 brief，理解后用自己的话开场，不要照读）\n${brief}`);
      const questions = (task.questions || '').trim();
      if (questions) parts.push(`【问题框架】（这次要聊清楚的要点，按对话节奏自然展开，不必逐字照问）\n${questions}`);
    }

    const bg = this.background();
    if (bg) parts.push(`【团队背景】（帮助你理解对方在说什么，不要照读出来）\n${bg}`);

    const memberCtx = (member.context || '').trim();
    if (memberCtx) parts.push(`【关于 ${name}】（这位同事的角色和需要重点关注的点）\n${memberCtx}`);

    // Auto-maintained profile — merged from past reports after each standup.
    const profile = (member.profile || '').trim();
    if (profile) parts.push(`【${name} 的动态画像】（根据其过往日报自动整理，帮助你理解上下文，不要照读出来）\n${profile}`);

    const probing = this.probing();
    if (probing) parts.push(`【追问指引】（据此决定要不要追问、追问到什么程度；这是内部指引，不要读出来）\n${probing}`);

    parts.push(
      `你有两个工具可以在需要时调用：` +
      `recall_member_history —— 当你想确认对方上次汇报说了什么、或想跟进之前的进展/卡点时调用；` +
      `search_team_knowledge —— 当对方提到某个项目/名词你需要背景、或需要核对团队已有信息时调用。` +
      `只在真的需要时调用，别打断对话节奏；拿到结果后自然地用在追问里，不要念工具或技术细节。`
    );

    parts.push(
      `最重要的规则：只回应对方真实说过的内容。如果没听清、没听懂或音频断续，直接说"不好意思我没听清，能再说一遍吗"，绝对禁止猜测、脑补或编造对方没说过的事，更不能把猜测写进小结。等对方把话说完再开口，不要抢话。`
    );

    parts.push(generic
      ? `结束：问题框架里的要点都聊到（或对方表示没有更多想说的）后，调用 submit_conversation_summary 提交小结，然后用一两句话口头跟对方确认要点并道别。不要念出完整清单，不要提"函数"或任何技术细节。`
      : `结束：四件事都聊到后，调用 submit_standup_summary 提交小结，然后用一两句话口头跟对方确认要点并道别。不要念出完整清单，不要提"函数"或任何技术细节。`
    );

    return parts.join('\n\n');
  }

  // ---- tool result formatting (kept compact — this is spoken back over audio) ----

  /** recall_member_history → compact JSON the model can weave into a follow-up. */
  recallHistory(member, excludeDate, days = 5) {
    const rows = this.store.recallMemberHistory(member.id, excludeDate, days);
    const parse = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
    return {
      member: member.name,
      count: rows.length,
      reports: rows.map(r => ({
        date: r.report_date,
        yesterday: parse(r.yesterday),
        today: parse(r.today),
        blockers: parse(r.blockers),
        topics: parse(r.topics),
      })),
    };
  }

  /** search_team_knowledge → top matches, content trimmed for the audio path. */
  searchKnowledge(query, limit = 3) {
    const hits = this.store.searchKnowledge(query, limit);
    return {
      query,
      count: hits.length,
      results: hits.map(h => ({
        title: h.title,
        content: h.content.length > 600 ? `${h.content.slice(0, 600)}…` : h.content,
        tags: h.tags || '',
      })),
    };
  }
}

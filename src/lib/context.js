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
  buildInstructions(member, task = null, prior = null, timeZone = 'Asia/Shanghai') {
    const name = member.name;
    const generic = task && !task.is_builtin;
    const recurring = generic && task.type === 'recurring';
    // Fresh wall-clock time every session — the model has no clock of its own
    // and defaults to morning-greeting phrasing ("早安") at any hour without it.
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(now);
    const hm = new Intl.DateTimeFormat('zh-CN', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(now);
    const hour = Number(hm.split(':')[0]);
    const period = hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
    const timeLine = `现在是${dateStr}，${period} ${hm}。打招呼和措辞要符合这个时间段（比如下午就不要说早安），提到"今天/昨天"也以这个日期为准。`;
    // Continuation sessions get a continuation flow INSTEAD of the scripted
    // opening — leaving the original flow line in and overriding it later
    // (【已聊过的内容】 block / opener kick) loses against weaker models,
    // which still re-run the script. Remove the contradiction at the source.
    const contFlow = prior?.transcript
      ? (prior.submitted
        ? `流程（继续模式）：${generic ? '本周期' : '今天'}的汇报早些时候已经聊完并提交过小结，这次是对方主动回来补充。开场简短打个招呼并用一句话自然衔接（比如"我们接着刚才的继续"），然后直接问对方有什么想补充或更新的，围绕对方说的内容自然展开。绝对不要重新走完整的提问流程，绝对不要把已经聊过的问题再问一遍。`
        : `流程（继续模式）：早些时候的对话中断了，这次是接着聊。开场简短打个招呼并用一句话自然衔接，然后从中断的地方继续，只补还没聊到的部分，已经聊清楚的绝对不要重复问。`)
      : null;
    const parts = generic ? [
      recurring
        ? `你是 Luna，代表团队负责人和同事「${name}」就「${task.title}」做本期的一对一语音沟通（这是一个定期进行的沟通任务）。全程说中文，口语自然、简短友好。`
        : `你是 Luna，代表团队负责人和同事「${name}」做一次一对一语音沟通，主题是「${task.title}」。全程说中文，口语自然、简短友好。`,
      `流程：先简单打招呼并说明这次想聊的主题，然后按下面的任务背景和问题框架逐个展开。一次只问一个问题，对方明显说完了再进入下一个；听到值得深入的点可以自然追问。整个对话控制在十分钟以内。`,
    ] : [
      `你是团队的日报助手 Luna，正在和同事「${name}」做每日语音汇报，全程说中文，口语自然、简短友好。`,
      `流程：先简单打个招呼，然后依次了解四件事：1) 昨天做了什么；2) 今天准备做什么；3) 有什么卡点或风险；4) 有什么问题需要在今天日会上讨论。一次只问一个问题，对方明显说完了就进入下一题，整个对话控制在五分钟以内。`,
    ];
    if (contFlow) parts[1] = contFlow;
    parts.splice(1, 0, timeLine);

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

    // Task-level probing overlay — scenario-specific follow-up strategy layered
    // on top of the global guidance (same layering as brief/questions).
    const taskProbe = (task?.probe_instruction || '').trim();
    if (taskProbe) parts.push(`【本任务的追问指引】（针对这次沟通任务的追问重点，优先于通用指引）\n${taskProbe}`);

    // Same-cycle continuation: an earlier session (dropped connection, page
    // refresh, or a reopened finished call) already covered part of the flow.
    if (prior?.transcript) {
      const t = prior.transcript.length > 4000 ? `……（更早的内容略）\n${prior.transcript.slice(-4000)}` : prior.transcript;
      parts.push(
        `【已聊过的内容】（这是${generic ? '本周期' : '今天'}早些时候你们已经聊过的对话记录，可能因断线或刷新中断。这次是继续，不是重新开始：开场用一句话自然衔接（比如"我们接着刚才的继续"），已经聊清楚的问题绝对不要重复问，直接从中断的地方接着聊${prior.submitted ? '。小结之前已经提交过：如果对方这次补充了新内容，等对方明确表示结束时再把新旧内容合并重新提交一次小结；如果只是闲聊没有新信息，不用重复提交。注意：已提交过不等于可以早点收尾，这次对话该聊多久聊多久' : ''}）\n${t}`
      );
    }

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

    parts.push(
      `提交时机的硬规则：只有在对方明确表示要结束时（比如说"就这些""没有了""先到这""再见"，或系统提示对方按了结束按钮）才允许调用提交。以下情况绝对不要提交：对方话没说完、你刚问的问题还没得到回答、对方正在补充或纠正你的理解。拿不准就先问一句"还有要补充的吗？"，得到明确答复再决定。`
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

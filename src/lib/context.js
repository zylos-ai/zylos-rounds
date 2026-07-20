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

// The global probing_guidance is a cross-task overlay that applies to EVERY
// task. It defaults to EMPTY on purpose: daily-standup-specific probing does
// not belong in a global container that also feeds unrelated communication
// tasks. Owner ruling (2026-07-20): global default empty (teams append their
// own if they want it), while the built-in daily standup carries its own
// code-level default probe (see dailyProbeDefault in INSTRUCTION_STRINGS).
export const DEFAULT_PROBING_GUIDANCE = '';

/**
 * Per-language instruction templates. The zh strings are the original
 * battle-tested set (byte-identical to pre-v0.12); en mirrors every rule
 * one-to-one. When tuning a rule, change BOTH languages in the same commit.
 */
const INSTRUCTION_STRINGS = {
  zh: {
    locale: 'zh-CN',
    period: hour => hour < 5 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上',
    timeLine: (dateStr, period, hm) => `现在是${dateStr}，${period} ${hm}。打招呼和措辞要符合这个时间段（比如下午就不要说早安），提到"今天/昨天"也以这个日期为准。`,
    contFlowSubmitted: generic => `流程（继续模式）：${generic ? '本周期' : '今天'}的汇报早些时候已经聊完并提交过小结，这次是对方主动回来补充。开场简短打个招呼并用一句话自然衔接（比如"我们接着刚才的继续"），然后直接问对方有什么想补充或更新的，围绕对方说的内容自然展开。绝对不要重新走完整的提问流程，绝对不要把已经聊过的问题再问一遍。`,
    contFlowInterrupted: `流程（继续模式）：早些时候的对话中断了，这次是接着聊。开场简短打个招呼并用一句话自然衔接，然后从中断的地方继续，只补还没聊到的部分，已经聊清楚的绝对不要重复问。`,
    personaRecurring: (name, title) => `你是 Luna，代表团队负责人和同事「${name}」就「${title}」做本期的一对一语音沟通（这是一个定期进行的沟通任务）。全程说中文，口语自然、简短友好。`,
    personaOneshot: (name, title) => `你是 Luna，代表团队负责人和同事「${name}」做一次一对一语音沟通，主题是「${title}」。全程说中文，口语自然、简短友好。`,
    personaDaily: name => `你是团队的日报助手 Luna，正在和同事「${name}」做每日语音汇报，全程说中文，口语自然、简短友好。`,
    flowGeneric: `流程：先简单打招呼并说明这次想聊的主题，然后按下面的任务背景和问题框架逐个展开。一次只问一个问题，对方明显说完了再进入下一个；听到值得深入的点可以自然追问。整个对话控制在十分钟以内。`,
    flowDaily: `流程：先简单打个招呼，然后依次了解四件事：1) 昨天做了什么；2) 今天准备做什么；3) 有什么卡点——卡点指前置依赖：在等谁/等什么、卡住了哪件事，点对点沟通就能解决的阻塞；4) 有什么待议题——待议题指需要上日会的事：多方拉通对齐、方案取舍、需要负责人拍板的。一次只问一个问题，对方明显说完了就进入下一题。如果某个卡点听起来涉及多人协调或需要拍板，主动问一句"这个要不要放到日会上讨论"，对方同意就把它记进待议题。整个对话控制在五分钟以内。`,
    taskBrief: brief => `【任务背景】（负责人给你的 brief，理解后用自己的话开场，不要照读）\n${brief}`,
    taskQuestions: questions => `【问题框架】（这次要聊清楚的要点，按对话节奏自然展开，不必逐字照问）\n${questions}`,
    teamBackground: bg => `【团队背景】（帮助你理解对方在说什么，不要照读出来）\n${bg}`,
    aboutMember: (name, ctx) => `【关于 ${name}】（这位同事的角色和需要重点关注的点）\n${ctx}`,
    memberProfile: (name, profile) => `【${name} 的动态画像】（根据其过往日报自动整理，帮助你理解上下文，不要照读出来）\n${profile}`,
    probingGuidance: probing => `【追问指引】（据此决定要不要追问、追问到什么程度；这是内部指引，不要读出来）\n${probing}`,
    taskProbe: text => `【本任务的追问指引】（针对这次沟通任务的追问重点，优先于通用指引）\n${text}`,
    // Code-level default probe for the built-in daily standup. It ships in
    // every install and is always injected for the daily task; a custom
    // probe_instruction (if any) appends on top of it, so teams add only their
    // own delta and product improvements to this default reach everyone.
    dailyProbeDefault: `按这里的指引决定要不要追问、追问什么。没有命中的点就不要硬追，保持自然简短。

- 当对方提到一项工作时，确认它的完成状态：追问"这个做完了吗？还是还在进行中？"如果在进行中，追问大概进度或预计什么时候能搞完。如果对方用模糊措辞（如"在推进""差不多"），明确确认是已交付还是仍在做。目的是让每个事项都带上明确状态（已完成 / 进行中 / 刚启动）。
- 当对方说某件事"差不多做完/基本完成"时，追问一句是否已经验证过、怎么验证的。
- 当对方提到卡点时，追问一句在等谁/等什么、卡了多久；如果这个卡点涉及多人协调或需要拍板，问一句要不要放到日会上讨论，同意就记进待议题。
- 当对方今天的计划和昨天说的明显不一样时，可以轻轻问一句原因（必要时用 recall_member_history 看看上次说了什么）。
- 对方已经说得很具体，就不要为了追问而追问。`,
    transcriptTrimmed: `……（更早的内容略）`,
    priorTranscript: (generic, submitted, t) => `【已聊过的内容】（这是${generic ? '本周期' : '今天'}早些时候你们已经聊过的对话记录，可能因断线或刷新中断。这次是继续，不是重新开始：开场用一句话自然衔接（比如"我们接着刚才的继续"），已经聊清楚的问题绝对不要重复问，直接从中断的地方接着聊${submitted ? '。小结之前已经提交过：如果对方这次补充了新内容，等对方明确表示结束时再把新旧内容合并重新提交一次小结；如果只是闲聊没有新信息，不用重复提交。注意：已提交过不等于可以早点收尾，这次对话该聊多久聊多久' : ''}）\n${t}`,
    toolsLine: `你有两个工具可以在需要时调用：` +
      `recall_member_history —— 当你想确认对方上次汇报说了什么、或想跟进之前的进展/卡点时调用；` +
      `search_team_knowledge —— 当对方提到某个项目/名词你需要背景、或需要核对团队已有信息时调用。` +
      `只在真的需要时调用，别打断对话节奏；拿到结果后自然地用在追问里，不要念工具或技术细节。`,
    safetyLine: `最重要的规则：只回应对方真实说过的内容。如果没听清、没听懂或音频断续，直接说"不好意思我没听清，能再说一遍吗"，绝对禁止猜测、脑补或编造对方没说过的事，更不能把猜测写进小结。等对方把话说完再开口，不要抢话。`,
    endingGeneric: `结束：问题框架里的要点都聊到（或对方表示没有更多想说的）后，调用 submit_conversation_summary 提交小结，然后用一两句话口头跟对方确认要点并道别。不要念出完整清单，不要提"函数"或任何技术细节。`,
    endingDaily: `结束：四件事都聊到后，调用 submit_standup_summary 提交小结，然后用一两句话口头跟对方确认要点并道别。不要念出完整清单，不要提"函数"或任何技术细节。`,
    submitTiming: `提交时机的硬规则：只有在对方明确表示要结束时（比如说"就这些""没有了""先到这""再见"，或系统提示对方按了结束按钮）才允许调用提交。以下情况绝对不要提交：对方话没说完、你刚问的问题还没得到回答、对方正在补充或纠正你的理解。拿不准就先问一句"还有要补充的吗？"，得到明确答复再决定。`,
  },
  en: {
    locale: 'en-US',
    period: hour => hour < 5 ? 'early morning' : hour < 12 ? 'morning' : hour < 14 ? 'midday' : hour < 18 ? 'afternoon' : 'evening',
    timeLine: (dateStr, period, hm) => `It is now ${dateStr}, ${hm} in the ${period}. Match your greeting and wording to this time of day (don't say "good morning" in the afternoon), and treat "today/yesterday" relative to this date.`,
    contFlowSubmitted: generic => `Flow (continuation mode): ${generic ? "this cycle's" : "today's"} report was already completed and its summary submitted earlier; the member has come back to add something. Open with a brief greeting and one natural bridging sentence (like "let's pick up where we left off"), then ask directly what they'd like to add or update, and follow their lead. Absolutely do not re-run the full question flow, and absolutely do not re-ask questions that were already covered.`,
    contFlowInterrupted: `Flow (continuation mode): the earlier conversation was cut off; this session continues it. Open with a brief greeting and one natural bridging sentence, then continue from where it broke off — only cover what hasn't been discussed yet, and absolutely do not repeat questions that were already answered.`,
    personaRecurring: (name, title) => `You are Luna, speaking on behalf of the team lead in a one-on-one voice conversation with your colleague ${name} about "${title}" for this cycle (this is a recurring conversation task). Speak English throughout — conversational, brief and friendly.`,
    personaOneshot: (name, title) => `You are Luna, speaking on behalf of the team lead in a one-on-one voice conversation with your colleague ${name} on the topic "${title}". Speak English throughout — conversational, brief and friendly.`,
    personaDaily: name => `You are Luna, the team's standup assistant, doing the daily voice check-in with your colleague ${name}. Speak English throughout — conversational, brief and friendly.`,
    flowGeneric: `Flow: greet briefly and say what you'd like to talk about, then work through the task background and question frame below one item at a time. Ask one question at a time and move on only when they've clearly finished; follow up naturally on anything worth digging into. Keep the whole conversation under ten minutes.`,
    flowDaily: `Flow: greet briefly, then cover four things in order: 1) what they did yesterday; 2) what they plan to do today; 3) any blockers — a blocker is a prerequisite dependency: who/what they are waiting on and which work it blocks, solvable point-to-point; 4) any meeting topics — things that need the team meeting: multi-party alignment, trade-off choices, decisions the lead must make. Ask one question at a time and move to the next once they've clearly finished. If a blocker sounds like it involves coordinating several people or needs a decision, proactively ask "should this go on today's meeting agenda?" and record it as a meeting topic if they agree. Keep the whole conversation under five minutes.`,
    taskBrief: brief => `[Task background] (the lead's brief to you — understand it and open in your own words, don't read it out)\n${brief}`,
    taskQuestions: questions => `[Question frame] (the points to cover this time — weave them in naturally at the conversation's pace, no need to ask verbatim)\n${questions}`,
    teamBackground: bg => `[Team background] (context to help you understand what they're talking about — don't read it out)\n${bg}`,
    aboutMember: (name, ctx) => `[About ${name}] (this colleague's role and what to pay attention to)\n${ctx}`,
    memberProfile: (name, profile) => `[${name}'s dynamic profile] (auto-compiled from their past reports to give you context — don't read it out)\n${profile}`,
    probingGuidance: probing => `[Probing guidance] (use this to decide whether and how deep to follow up; internal guidance — don't read it out)\n${probing}`,
    taskProbe: text => `[This task's probing guidance] (follow-up priorities for this specific conversation; takes precedence over the general guidance)\n${text}`,
    // Code-level default probe for the built-in daily standup (see zh note).
    dailyProbeDefault: `Use this to decide whether and what to follow up on. Don't force a follow-up where nothing applies — keep it natural and brief.

- When they mention a piece of work, confirm its completion status: ask "is this done, or still in progress?" If in progress, ask roughly how far along it is or when it will be finished. If they're vague ("making progress", "almost there"), pin down whether it's actually delivered or still ongoing. The goal is that every item carries a clear status (done / in progress / just started).
- When they say something is "almost done / basically complete", ask whether it has been verified and how.
- When they mention a blocker, ask who/what they are waiting on and how long they have been stuck; if the blocker involves coordinating several people or needs a decision, ask whether it should go to the daily meeting, and record it as a meeting topic if they agree.
- When today's plan clearly differs from what they said yesterday, gently ask why (use recall_member_history to check what they said last time if needed).
- If they have already been specific, don't follow up just for the sake of it.`,
    transcriptTrimmed: `… (earlier content omitted)`,
    priorTranscript: (generic, submitted, t) => `[What was already discussed] (this is the transcript of the conversation you two already had earlier ${generic ? 'this cycle' : 'today'}, possibly cut off by a dropped connection or page refresh. This session is a continuation, not a restart: open with one natural bridging sentence (like "let's pick up where we left off"), absolutely do not repeat questions that were already covered, and continue straight from where it broke off${submitted ? '. The summary was already submitted: if they add new content this time, wait until they clearly say they are done, then re-submit one summary merging old and new; if it was just small talk with nothing new, don\'t re-submit. Note: having already submitted does not mean wrapping up early — let this conversation run as long as it needs' : ''})\n${t}`,
    toolsLine: `You have two tools you can call when needed: ` +
      `recall_member_history — call it when you want to check what they said in previous reports, or to follow up on earlier progress or blockers; ` +
      `search_team_knowledge — call it when they mention a project or term you need background on, or you need to check existing team information. ` +
      `Only call them when genuinely needed — don't break the conversation's rhythm; weave the results naturally into follow-ups, and never read out tool names or technical details.`,
    safetyLine: `The most important rule: only respond to what they actually said. If you didn't hear clearly, didn't understand, or the audio broke up, say "sorry, I didn't catch that — could you say it again?". Never guess, fill in, or invent things they didn't say, and never put guesses into the summary. Let them finish speaking before you start — don't talk over them.`,
    endingGeneric: `Ending: once the points in the question frame are covered (or they say there's nothing more), call submit_conversation_summary to submit the summary, then verbally confirm the key points in a sentence or two and say goodbye. Don't read out the full list, and never mention "functions" or any technical details.`,
    endingDaily: `Ending: once all four things are covered, call submit_standup_summary to submit the summary, then verbally confirm the key points in a sentence or two and say goodbye. Don't read out the full list, and never mention "functions" or any technical details.`,
    submitTiming: `Hard rule on submit timing: only call submit when they clearly indicate they're done (saying things like "that's all", "nothing else", "let's stop here", "bye", or a system note that they pressed the end button). Never submit when: they're mid-sentence, your last question hasn't been answered yet, or they're adding to or correcting your understanding. If unsure, ask "anything else to add?" first and decide after a clear answer.`,
  },
};

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
   *
   * `lang` ('zh' | 'en') selects the instruction language — it drives the
   * spoken language of the whole conversation. The two templates in
   * INSTRUCTION_STRINGS must stay semantically parallel: every hard-won rule
   * (anti-hallucination, submit timing, continuation mode) exists in both.
   */
  buildInstructions(member, task = null, prior = null, timeZone = 'Asia/Shanghai', lang = 'zh') {
    const L = INSTRUCTION_STRINGS[lang] || INSTRUCTION_STRINGS.zh;
    const name = member.name;
    const generic = task && !task.is_builtin;
    const recurring = generic && task.type === 'recurring';
    // Fresh wall-clock time every session — the model has no clock of its own
    // and defaults to morning-greeting phrasing ("早安") at any hour without it.
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat(L.locale, {
      timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(now);
    const hm = new Intl.DateTimeFormat(L.locale, {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(now);
    const hour = Number(hm.split(':')[0]);
    const period = L.period(hour);
    const timeLine = L.timeLine(dateStr, period, hm);
    // Continuation sessions get a continuation flow INSTEAD of the scripted
    // opening — leaving the original flow line in and overriding it later
    // (prior-transcript block / opener kick) loses against weaker models,
    // which still re-run the script. Remove the contradiction at the source.
    const contFlow = prior?.transcript
      ? (prior.submitted ? L.contFlowSubmitted(generic) : L.contFlowInterrupted)
      : null;
    const parts = generic ? [
      recurring ? L.personaRecurring(name, task.title) : L.personaOneshot(name, task.title),
      L.flowGeneric,
    ] : [
      L.personaDaily(name),
      L.flowDaily,
    ];
    if (contFlow) parts[1] = contFlow;
    parts.splice(1, 0, timeLine);

    if (generic) {
      const brief = (task.brief || '').trim();
      if (brief) parts.push(L.taskBrief(brief));
      const questions = (task.questions || '').trim();
      if (questions) parts.push(L.taskQuestions(questions));
    }

    const bg = this.background();
    if (bg) parts.push(L.teamBackground(bg));

    const memberCtx = (member.context || '').trim();
    if (memberCtx) parts.push(L.aboutMember(name, memberCtx));

    // Auto-maintained profile — merged from past reports after each standup.
    const profile = (member.profile || '').trim();
    if (profile) parts.push(L.memberProfile(name, profile));

    // Global probing guidance — a cross-task overlay, empty by default.
    const probing = this.probing();
    if (probing) parts.push(L.probingGuidance(probing));

    // Task-level probing. The built-in daily standup ships a code-level default
    // probe in every install; a custom probe_instruction (if any) APPENDS on
    // top of it (append, not override) so product improvements to the default
    // reach every team automatically. Non-daily tasks have no code default —
    // their probe is purely the custom field.
    const probeParts = [];
    if (!generic) probeParts.push(L.dailyProbeDefault);
    const customProbe = (task?.probe_instruction || '').trim();
    if (customProbe) probeParts.push(customProbe);
    const taskProbe = probeParts.join('\n\n');
    if (taskProbe) parts.push(L.taskProbe(taskProbe));

    // Same-cycle continuation: an earlier session (dropped connection, page
    // refresh, or a reopened finished call) already covered part of the flow.
    if (prior?.transcript) {
      const t = prior.transcript.length > 4000 ? `${L.transcriptTrimmed}\n${prior.transcript.slice(-4000)}` : prior.transcript;
      parts.push(L.priorTranscript(generic, prior.submitted, t));
    }

    parts.push(L.toolsLine);
    parts.push(L.safetyLine);
    parts.push(generic ? L.endingGeneric : L.endingDaily);
    parts.push(L.submitTiming);

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

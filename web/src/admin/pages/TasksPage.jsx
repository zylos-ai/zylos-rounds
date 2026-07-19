import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Loader2, Copy, Check, ExternalLink, Sparkles, RefreshCw,
  ChevronDown, ChevronRight, ArrowLeft, Trash2, CircleCheck, RotateCcw,
  Repeat, FlaskConical, NotebookPen,
} from 'lucide-react';
import { cn, copyText } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { api } from '../api';
import { navigate } from '../router';
import { useLangDict } from '../i18n';
import DayReportView from './DayReportView';

const DICT = {
  zh: {
    // badges + cadence
    statusOpen: '进行中',
    statusClosed: '已关闭',
    builtinPrefix: '内置 · ',
    recurring: '循环',
    oneoff: '一次性',
    cadenceDaily: '每天',
    cadenceWeeklyOpt: '每周',
    cadenceEveryN: '每 N 天',
    cadenceWeekly: (dows) => (dows.length
      ? `每周 ${dows.map((d) => ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][d]).join('/')}`
      : '每周'),
    cadenceInterval: (n) => `每 ${n} 天`,
    // list page
    loadFailed: '加载失败，请刷新重试',
    pageTitle: '沟通任务',
    pageDesc: '代表负责人与成员做一对一语音沟通：循环任务按周期收汇报，一次性任务按主题发起',
    newTask: '新建任务',
    recurringSection: '循环任务',
    oneoffSection: '一次性任务',
    oneoffEmpty: '还没有一次性任务。点「新建任务」发起一轮一对一沟通（如季度复盘、规划前置沟通）。',
    thisCycle: '本期',
    progressDone: (n, total) => `${n}/${total} 人已完成`,
    cycleStarted: (key) => ` · 本期始于 ${key}`,
    dueSuffix: (d) => ` · 截止 ${d}`,
    // create form
    membersLoadFailed: '成员列表加载失败',
    errTitleRequired: '请填写任务标题',
    errMemberRequired: '请至少选择一位成员',
    errDowRequired: '每周任务请至少选择一个周几',
    errIntervalRange: '自定义间隔请填 1-365 的天数',
    createFailed: '创建失败，请重试',
    taskType: '任务类型',
    cycleLabel: '周期',
    weeklyOn: '周',
    dowShort: ['', '一', '二', '三', '四', '五', '六', '日'],
    intervalPrefix: '每',
    intervalSuffix: '天一个周期，从今天开始',
    titleLabel: '任务标题',
    titlePhRecurring: '如：团队周报',
    titlePhOneshot: '如：Q2 复盘一对一沟通',
    briefLabel: '任务背景（brief，agent 用它开场和把握上下文）',
    briefPh: '给 agent 的背景说明：为什么发起这轮沟通、负责人关心什么…',
    questionsLabel: '问题框架（要聊清楚的要点，自由文本）',
    questionsPh: '- 这个季度你觉得做得最好和最遗憾的事\n- 团队协作里最卡的环节\n- 下季度最想推进的一件事',
    probeLabel: '追问指引（可选，叠加在大脑的通用追问指引之上）',
    probePh: '这次沟通要重点追什么、追到什么深度。例如：\n- 提到延期时，追问影响面和新的时间点\n- 只聊结论不聊过程时，追一个具体例子',
    digestInstrLabel: '汇总 instruction（可选，不填用默认模板）',
    digestInstrPhRecurring: '默认模板：进展要点 / 共性主题 / 重点信号。想换个结构或口径就写在这里。',
    digestInstrPhOneshot: '默认模板：共识 / 分歧 / 重点信号。想换个结构或口径就写在这里。',
    participantsLabel: '参与成员（每人会生成该任务专属链接）',
    deadlineLabel: '截止日期（可选）',
    autoAtLabel: '自动生成汇总时间（可选，默认手工触发）',
    closeLinkedLabel: '生成汇总时自动关闭任务',
    cancel: '取消',
    createTask: '创建任务',
    // detail page
    notFound: '任务不存在或加载失败',
    digestEmptyCycle: '这一期还没有人完成对话，暂无内容可汇总',
    digestFailed: '汇总生成失败，请重试',
    backToList: '返回任务列表',
    thisCyclePrefix: '本期 ',
    disableDaily: '停用日报',
    closeTask: '关闭任务',
    reopenTask: '重新打开',
    del: '删除',
    deleteTitle: (title) => `删除任务「${title}」？`,
    deleteDesc: '任务、成员链接和已收集的对话小结都会删除，不可恢复。',
    briefCard: '任务背景',
    questionsCard: '问题框架',
    cycleDigest: '本期汇总',
    taskDigest: '任务汇总',
    digestUpdatedAt: (ts) => `更新于 ${ts} · 重新生成会覆盖`,
    digestAutoRecurring: '周期结束自动生成，也可随时手工触发',
    digestManual: '默认手工触发，可随时生成',
    digestAutoSet: (ts, closeLinked) => ` · 已设自动生成 ${ts}${closeLinked ? '（生成后自动关闭）' : ''}`,
    digestCustomInstr: ' · 已自定义汇总 instruction',
    regenDigest: '重新生成汇总',
    genDigest: '生成汇总',
    digestNotYet: '尚未生成。成员完成对话后点「生成汇总」',
    digestNotYetCustom: '，按自定义 instruction 输出。',
    digestNotYetRecurring: '，输出进展要点 / 共性主题 / 重点信号。',
    digestNotYetOneshot: '，输出共识 / 分歧 / 重点信号。',
    participants: '参与成员',
    cycleFrom: (key, current) => `${key} 起的这一期${current ? '（本期）' : ''}`,
    memberDone: '已完成',
    memberPending: '待沟通',
    copyTaskLink: (name) => `复制 ${name} 的任务链接`,
    openTaskLink: (name) => `打开 ${name} 的任务链接`,
    expandSummary: '展开小结',
    keyPoints: '要点',
    keySignals: '重点信号',
    transcriptLabel: (mins) => `原始对话（${mins != null ? `${mins} 分钟` : '—'}）`,
    currentCycleSuffix: '（本期）',
    // reset link
    resetLinkTitle: (name) => `重置 ${name} 的任务链接`,
    resetLinkConfirm: (name) => `重置「${name}」的任务链接？`,
    resetLinkDesc: '会生成一个新链接，旧链接立即失效。新链接会自动复制到剪贴板。',
    resetLink: '重置链接',
    // member links card (built-in daily)
    memberLinks: '成员链接',
    memberLinksDesc: '每位成员用自己的任务专属链接进入语音汇报；任务停用后链接即失效',
    reported: '已汇报',
    notReported: '待汇报',
    copyLink: (name) => `复制 ${name} 的链接`,
    openLink: (name) => `打开 ${name} 的链接`,
    testLink: '体验链接',
    testLinkDesc: '任何人可用它体验语音对话，内容不计入正式汇报',
    copyTestLink: '复制体验链接',
    openTestLink: '打开体验链接',
    // probe instruction card
    saveFailed: '保存失败，请重试',
    probeCardTitle: '追问指引（本任务）',
    probeEdit: '编辑本任务的追问指引',
    probeSet: '设置本任务的追问指引',
    probeDialogTitle: (title) => `「${title}」的追问指引`,
    probeDialogDesc: '写这次沟通要重点追什么、追到什么深度。叠加在大脑的通用追问指引之上生效，只作用于这个任务，改动即时生效。',
    save: '保存',
    probeUnset: '未设置——只用大脑里的通用追问指引',
  },
  en: {
    // badges + cadence
    statusOpen: 'Open',
    statusClosed: 'Closed',
    builtinPrefix: 'Built-in · ',
    recurring: 'Recurring',
    oneoff: 'One-off',
    cadenceDaily: 'Daily',
    cadenceWeeklyOpt: 'Weekly',
    cadenceEveryN: 'Every N days',
    cadenceWeekly: (dows) => (dows.length
      ? `Weekly ${dows.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join('/')}`
      : 'Weekly'),
    cadenceInterval: (n) => `Every ${n} days`,
    // list page
    loadFailed: 'Failed to load. Refresh to retry.',
    pageTitle: 'Communication Tasks',
    pageDesc: 'One-on-one voice conversations with members on the owner’s behalf: recurring tasks collect reports each cycle, one-off tasks are launched around a topic',
    newTask: 'New Task',
    recurringSection: 'Recurring tasks',
    oneoffSection: 'One-off tasks',
    oneoffEmpty: 'No one-off tasks yet. Click "New Task" to start a round of one-on-one conversations (e.g. a quarterly retro or pre-planning sync).',
    thisCycle: 'This cycle',
    progressDone: (n, total) => `${n}/${total} completed`,
    cycleStarted: (key) => ` · cycle started ${key}`,
    dueSuffix: (d) => ` · due ${d}`,
    // create form
    membersLoadFailed: 'Failed to load members',
    errTitleRequired: 'Please enter a task title',
    errMemberRequired: 'Please select at least one member',
    errDowRequired: 'Weekly tasks need at least one weekday selected',
    errIntervalRange: 'Custom interval must be between 1 and 365 days',
    createFailed: 'Failed to create. Please retry.',
    taskType: 'Task type',
    cycleLabel: 'Cycle',
    weeklyOn: 'On',
    dowShort: ['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
    intervalPrefix: 'Every',
    intervalSuffix: 'days per cycle, starting today',
    titleLabel: 'Task title',
    titlePhRecurring: 'e.g. Weekly team report',
    titlePhOneshot: 'e.g. Q2 retro one-on-ones',
    briefLabel: 'Brief (background the agent uses to open and frame the conversation)',
    briefPh: 'Background for the agent: why this round is happening, what the owner cares about…',
    questionsLabel: 'Question frame (points to cover, free text)',
    questionsPh: '- The best and most regrettable things this quarter\n- Where team collaboration gets stuck the most\n- The one thing you most want to push next quarter',
    probeLabel: 'Probing guidance (optional, layered on top of the brain’s general guidance)',
    probePh: 'What to probe in this round and how deep. For example:\n- When a delay comes up, probe the impact and the new date\n- When only conclusions are shared, ask for a concrete example',
    digestInstrLabel: 'Digest instruction (optional; default template if empty)',
    digestInstrPhRecurring: 'Default template: progress highlights / common themes / key signals. Write here to change the structure or angle.',
    digestInstrPhOneshot: 'Default template: consensus / disagreements / key signals. Write here to change the structure or angle.',
    participantsLabel: 'Participants (each member gets a task-specific link)',
    deadlineLabel: 'Deadline (optional)',
    autoAtLabel: 'Auto-digest time (optional; manual trigger by default)',
    closeLinkedLabel: 'Close the task automatically when the digest is generated',
    cancel: 'Cancel',
    createTask: 'Create Task',
    // detail page
    notFound: 'Task not found or failed to load',
    digestEmptyCycle: 'No one has completed a conversation this cycle — nothing to digest yet',
    digestFailed: 'Failed to generate digest. Please retry.',
    backToList: 'Back to tasks',
    thisCyclePrefix: 'This cycle ',
    disableDaily: 'Disable daily standup',
    closeTask: 'Close task',
    reopenTask: 'Reopen',
    del: 'Delete',
    deleteTitle: (title) => `Delete task "${title}"?`,
    deleteDesc: 'The task, member links, and collected conversation summaries will be deleted. This cannot be undone.',
    briefCard: 'Brief',
    questionsCard: 'Question frame',
    cycleDigest: 'Cycle digest',
    taskDigest: 'Task digest',
    digestUpdatedAt: (ts) => `Updated ${ts} · regenerating overwrites it`,
    digestAutoRecurring: 'Generated automatically at cycle end; you can also trigger it manually anytime',
    digestManual: 'Manual trigger by default; generate anytime',
    digestAutoSet: (ts, closeLinked) => ` · auto-digest scheduled for ${ts}${closeLinked ? ' (task closes after)' : ''}`,
    digestCustomInstr: ' · custom digest instruction set',
    regenDigest: 'Regenerate digest',
    genDigest: 'Generate digest',
    digestNotYet: 'Not generated yet. Once members finish their conversations, click "Generate digest"',
    digestNotYetCustom: ' to output using your custom instruction.',
    digestNotYetRecurring: ' to output progress highlights / common themes / key signals.',
    digestNotYetOneshot: ' to output consensus / disagreements / key signals.',
    participants: 'Participants',
    cycleFrom: (key, current) => `cycle starting ${key}${current ? ' (current)' : ''}`,
    memberDone: 'Done',
    memberPending: 'Pending',
    copyTaskLink: (name) => `Copy ${name}'s task link`,
    openTaskLink: (name) => `Open ${name}'s task link`,
    expandSummary: 'Toggle summary',
    keyPoints: 'Key points',
    keySignals: 'Key signals',
    transcriptLabel: (mins) => `Transcript (${mins != null ? `${mins} min` : '—'})`,
    currentCycleSuffix: ' (current)',
    // reset link
    resetLinkTitle: (name) => `Reset ${name}'s task link`,
    resetLinkConfirm: (name) => `Reset ${name}'s task link?`,
    resetLinkDesc: 'A new link will be generated and the old one stops working immediately. The new link is copied to your clipboard.',
    resetLink: 'Reset link',
    // member links card (built-in daily)
    memberLinks: 'Member links',
    memberLinksDesc: 'Each member joins the voice report via their own task-specific link; links stop working once the task is disabled',
    reported: 'Reported',
    notReported: 'Pending',
    copyLink: (name) => `Copy ${name}'s link`,
    openLink: (name) => `Open ${name}'s link`,
    testLink: 'Try-it link',
    testLinkDesc: 'Anyone can use it to try the voice conversation; nothing counts toward official reports',
    copyTestLink: 'Copy try-it link',
    openTestLink: 'Open try-it link',
    // probe instruction card
    saveFailed: 'Failed to save. Please retry.',
    probeCardTitle: 'Probing guidance (this task)',
    probeEdit: 'Edit this task’s probing guidance',
    probeSet: 'Set this task’s probing guidance',
    probeDialogTitle: (title) => `Probing guidance for "${title}"`,
    probeDialogDesc: 'Describe what to probe in this round and how deep. It layers on top of the brain’s general probing guidance, applies only to this task, and takes effect immediately.',
    save: 'Save',
    probeUnset: 'Not set — only the brain’s general probing guidance applies',
  },
};

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

// Client-side cadence label from the structured cadence fields (the server's
// cadence_label is Chinese-only).
const cadenceLabel = (task, T) => {
  if (task.cadence_type === 'daily') return T.cadenceDaily;
  if (task.cadence_type === 'weekly') {
    const dows = (task.cadence_dow || '').split(',').filter(Boolean).map(Number);
    return T.cadenceWeekly(dows);
  }
  if (task.cadence_type === 'interval') return T.cadenceInterval(task.cadence_interval_days);
  return T.recurring;
};

const statusBadge = (task, T) =>
  task.status === 'open'
    ? <Badge className="bg-primary-soft text-primary border-transparent">{T.statusOpen}</Badge>
    : <Badge variant="secondary">{T.statusClosed}</Badge>;

const typeBadge = (task, T) => task.type === 'recurring'
  ? (
    <Badge variant="secondary" className="gap-1">
      <Repeat className="h-3 w-3" strokeWidth={2} />
      {task.is_builtin ? T.builtinPrefix : ''}{cadenceLabel(task, T)}
    </Badge>
  )
  : <Badge variant="secondary">{T.oneoff}</Badge>;

/* ---------------- list + create ---------------- */

export function TasksPage() {
  const T = useLangDict(DICT);
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api('api/tasks'));
    } catch (err) {
      if (err.status !== 401) setData({ error: true });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (data === null) {
    return <div className="flex justify-center pt-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (data.error) return <p className="pt-10 text-center text-muted-foreground">{T.loadFailed}</p>;

  const recurring = data.tasks.filter((t) => t.type === 'recurring');
  const oneshots = data.tasks.filter((t) => t.type === 'oneshot');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">{T.pageTitle}</h1>
          <p className="mt-2 text-muted-foreground">{T.pageDesc}</p>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" strokeWidth={2} />{T.newTask}
        </Button>
      </div>

      {creating && <CreateTaskCard onDone={() => { setCreating(false); load(); }} />}

      {recurring.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground">{T.recurringSection}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {recurring.map((t) => <TaskCard key={t.id} task={t} progressLabel={T.thisCycle} />)}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">{T.oneoffSection}</h2>
        {oneshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.oneoffEmpty}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {oneshots.map((t) => <TaskCard key={t.id} task={t} progressLabel="" />)}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task, progressLabel }) {
  const T = useLangDict(DICT);
  return (
    <Card className="cursor-pointer transition-colors hover:border-ring" onClick={() => navigate(`#/tasks/${task.id}`)}>
      <CardContent className="py-5">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-semibold">{task.title}</span>
          <div className="flex shrink-0 items-center gap-2">
            {typeBadge(task, T)}
            {statusBadge(task, T)}
          </div>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {progressLabel ? `${progressLabel} ` : ''}{T.progressDone(task.submitted_count, task.member_count)}
          {task.type === 'recurring' && task.cycle_key ? T.cycleStarted(task.cycle_key) : ''}
          {task.deadline ? T.dueSuffix(task.deadline) : ''}
        </p>
      </CardContent>
    </Card>
  );
}

const DOW_VALUES = [1, 2, 3, 4, 5, 6, 7];

function CreateTaskCard({ onDone }) {
  const T = useLangDict(DICT);
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [type, setType] = useState('oneshot');
  const [cadence, setCadence] = useState('daily');
  const [dows, setDows] = useState(new Set([1]));
  const [every, setEvery] = useState('7');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [questions, setQuestions] = useState('');
  const [digestInstruction, setDigestInstruction] = useState('');
  const [probeInstruction, setProbeInstruction] = useState('');
  const [deadline, setDeadline] = useState('');
  const [autoAt, setAutoAt] = useState('');
  const [closeLinked, setCloseLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('api/members').then((r) => {
      setMembers(r.members);
      setSelected(new Set(r.members.map((m) => m.id)));
    }).catch(() => setError(T.membersLoadFailed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleDow = (v) => setDows((s) => {
    const n = new Set(s);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  });

  const submit = async () => {
    setError('');
    if (!title.trim()) return setError(T.errTitleRequired);
    if (!selected.size) return setError(T.errMemberRequired);
    if (type === 'recurring' && cadence === 'weekly' && !dows.size) return setError(T.errDowRequired);
    const everyN = Number(every);
    if (type === 'recurring' && cadence === 'interval' && (!Number.isInteger(everyN) || everyN < 1 || everyN > 365)) {
      return setError(T.errIntervalRange);
    }
    setBusy(true);
    try {
      const body = { title: title.trim(), member_ids: [...selected] };
      if (type === 'recurring') {
        body.type = 'recurring';
        body.cadence_type = cadence;
        if (cadence === 'weekly') body.cadence_dow = [...dows].sort().join(',');
        if (cadence === 'interval') body.cadence_interval_days = everyN;
      }
      if (brief.trim()) body.brief = brief.trim();
      if (questions.trim()) body.questions = questions.trim();
      if (digestInstruction.trim()) body.digest_instruction = digestInstruction.trim();
      if (probeInstruction.trim()) body.probe_instruction = probeInstruction.trim();
      if (type === 'oneshot') {
        if (deadline) body.deadline = deadline;
        if (autoAt) body.digest_auto_at = autoAt;
        body.digest_close_linked = closeLinked;
      }
      const t = await api('api/tasks', { method: 'POST', body });
      onDone();
      navigate(`#/tasks/${t.id}`);
    } catch {
      setError(T.createFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">{T.taskType}</label>
          <div className="flex gap-2">
            {[['oneshot', T.oneoff], ['recurring', T.recurring]].map(([v, label]) => (
              <button key={v} type="button" onClick={() => setType(v)}
                className={cn('rounded-full border px-4 py-1.5 text-sm transition-colors',
                  type === v
                    ? 'border-transparent bg-primary-soft text-primary font-medium'
                    : 'border-border text-muted-foreground hover:border-ring')}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {type === 'recurring' && (
          <div className="space-y-3 rounded-lg border border-dashed border-border-strong px-4 py-4">
            <label className="text-sm font-medium">{T.cycleLabel}</label>
            <div className="flex flex-wrap gap-2">
              {[['daily', T.cadenceDaily], ['weekly', T.cadenceWeeklyOpt], ['interval', T.cadenceEveryN]].map(([v, label]) => (
                <button key={v} type="button" onClick={() => setCadence(v)}
                  className={cn('rounded-full border px-4 py-1.5 text-sm transition-colors',
                    cadence === v
                      ? 'border-transparent bg-primary-soft text-primary font-medium'
                      : 'border-border text-muted-foreground hover:border-ring')}>
                  {label}
                </button>
              ))}
            </div>
            {cadence === 'weekly' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">{T.weeklyOn}</span>
                {DOW_VALUES.map((d) => (
                  <button key={d} type="button" onClick={() => toggleDow(d)}
                    className={cn('h-9 w-9 rounded-full border text-sm transition-colors',
                      dows.has(d)
                        ? 'border-transparent bg-primary-soft text-primary font-medium'
                        : 'border-border text-muted-foreground hover:border-ring')}>
                    {T.dowShort[d]}
                  </button>
                ))}
              </div>
            )}
            {cadence === 'interval' && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{T.intervalPrefix}</span>
                <Input type="number" min="1" max="365" value={every} onChange={(e) => setEvery(e.target.value)} className="w-20" />
                <span className="text-muted-foreground">{T.intervalSuffix}</span>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">{T.titleLabel}</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={type === 'recurring' ? T.titlePhRecurring : T.titlePhOneshot} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{T.briefLabel}</label>
          <textarea className={TEXTAREA_CLASS} rows={4} value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder={T.briefPh} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{T.questionsLabel}</label>
          <textarea className={TEXTAREA_CLASS} rows={4} value={questions} onChange={(e) => setQuestions(e.target.value)}
            placeholder={T.questionsPh} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{T.probeLabel}</label>
          <textarea className={TEXTAREA_CLASS} rows={3} value={probeInstruction} onChange={(e) => setProbeInstruction(e.target.value)}
            placeholder={T.probePh} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{T.digestInstrLabel}</label>
          <textarea className={TEXTAREA_CLASS} rows={3} value={digestInstruction} onChange={(e) => setDigestInstruction(e.target.value)}
            placeholder={type === 'recurring' ? T.digestInstrPhRecurring : T.digestInstrPhOneshot} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{T.participantsLabel}</label>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => (
              <button key={m.id} type="button" onClick={() => toggle(m.id)}
                className={cn('rounded-full border px-3.5 py-1.5 text-sm transition-colors',
                  selected.has(m.id)
                    ? 'border-transparent bg-primary-soft text-primary font-medium'
                    : 'border-border text-muted-foreground hover:border-ring')}>
                {m.name}
              </button>
            ))}
          </div>
        </div>
        {type === 'oneshot' && (
          <div className="flex flex-wrap items-end gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">{T.deadlineLabel}</label>
              <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="w-44" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{T.autoAtLabel}</label>
              <Input type="datetime-local" value={autoAt} onChange={(e) => setAutoAt(e.target.value)} className="w-56" />
            </div>
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" checked={closeLinked} onChange={(e) => setCloseLinked(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
              {T.closeLinkedLabel}
            </label>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onDone}>{T.cancel}</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{T.createTask}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------------- detail ---------------- */

function DigestCard({ task, digesting, digestError, onTrigger }) {
  const T = useLangDict(DICT);
  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{task.type === 'recurring' ? T.cycleDigest : T.taskDigest}</h2>
          <span className="text-sm text-muted-foreground">
            {task.digest_updated_at
              ? T.digestUpdatedAt(task.digest_updated_at.slice(0, 16))
              : task.is_builtin ? T.digestManual
                : task.type === 'recurring' ? T.digestAutoRecurring : T.digestManual}
            {task.digest_auto_at ? T.digestAutoSet(task.digest_auto_at.slice(0, 16), task.digest_close_linked) : ''}
            {task.digest_instruction ? T.digestCustomInstr : ''}
          </span>
          <Button size="sm" className="ml-auto" onClick={onTrigger} disabled={digesting}>
            {digesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {task.digest ? T.regenDigest : T.genDigest}
          </Button>
        </div>
        {digestError && <p className="mb-3 text-sm text-destructive">{digestError}</p>}
        {task.digest
          ? <div className="whitespace-pre-wrap rounded-md bg-accent/50 px-4 py-3 text-[0.95rem] leading-relaxed">{task.digest}</div>
          : <p className="text-sm text-muted-foreground">{T.digestNotYet}{task.digest_instruction ? T.digestNotYetCustom : task.type === 'recurring' ? T.digestNotYetRecurring : T.digestNotYetOneshot}</p>}
      </CardContent>
    </Card>
  );
}

export function TaskDetailPage({ id, cycle }) {
  const T = useLangDict(DICT);
  const [task, setTask] = useState(null);
  const [digesting, setDigesting] = useState(false);
  const [digestError, setDigestError] = useState('');
  const [copied, setCopied] = useState(0);
  const [expanded, setExpanded] = useState(new Set());
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      setTask(await api(`api/tasks/${id}${cycle ? `?cycle=${encodeURIComponent(cycle)}` : ''}`));
    } catch (err) {
      if (err.status !== 401) setTask({ error: true });
    }
  }, [id, cycle]);
  useEffect(() => { setTask(null); load(); }, [load]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  if (task === null) {
    return <div className="flex justify-center pt-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (task.error) return <p className="pt-10 text-center text-muted-foreground">{T.notFound}</p>;

  const isCurrentCycle = !task.current_cycle_key || task.cycle_key === task.current_cycle_key;

  const copy = async (key, link) => {
    if (await copyText(link)) {
      setCopied(key);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(0), 1500);
    }
  };
  const toggleExpand = (memberId) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(memberId)) n.delete(memberId); else n.add(memberId);
    return n;
  });

  const triggerDigest = async () => {
    setDigesting(true);
    setDigestError('');
    try {
      const body = {};
      if (task.type === 'recurring' && task.cycle_key) body.cycle = task.cycle_key;
      const fresh = await api(`api/tasks/${id}/digest`, { method: 'POST', body });
      setTask(fresh);
    } catch (err) {
      setDigestError(err.status === 409 ? T.digestEmptyCycle : T.digestFailed);
    } finally {
      setDigesting(false);
    }
  };

  const setStatus = async (action) => {
    await api(`api/tasks/${id}/${action}`, { method: 'POST', body: {} });
    await load();
  };

  const remove = async () => {
    await api(`api/tasks/${id}`, { method: 'DELETE' });
    navigate('#/');
  };

  const resetLink = async (m) => {
    const r = await api(`api/tasks/${id}/members/${m.member_id}/reset-token`, { method: 'POST', body: {} });
    await copyText(r.link);
    await load();
  };

  return (
    <div className="space-y-8">
      <div>
        <a href="#/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />{T.backToList}
        </a>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{task.title}</h1>
          {typeBadge(task, T)}
          {statusBadge(task, T)}
          <span className="text-sm text-muted-foreground">
            {task.type === 'recurring' ? T.thisCyclePrefix : ''}{T.progressDone(task.submitted_count, task.member_count)}
            {task.deadline ? T.dueSuffix(task.deadline) : ''}
          </span>
          <div className="ml-auto flex gap-2">
            {task.status === 'open'
              ? <Button variant="outline" size="sm" onClick={() => setStatus('close')}><CircleCheck className="h-4 w-4" />{task.is_builtin ? T.disableDaily : T.closeTask}</Button>
              : <Button variant="outline" size="sm" onClick={() => setStatus('reopen')}><RotateCcw className="h-4 w-4" />{T.reopenTask}</Button>}
            {!task.is_builtin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-destructive"><Trash2 className="h-4 w-4" />{T.del}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{T.deleteTitle(task.title)}</AlertDialogTitle>
                    <AlertDialogDescription>{T.deleteDesc}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
                    <AlertDialogAction onClick={remove} className="bg-destructive text-white hover:bg-destructive/90">{T.del}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
        {task.type === 'recurring' && (
          <CycleSwitcher task={task} onSelect={(key) => navigate(`#/tasks/${id}/c/${key}`)} />
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {task.brief && (
          <Card><CardContent className="py-5">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{T.briefCard}</h2>
            <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{task.brief}</p>
          </CardContent></Card>
        )}
        {task.questions && (
          <Card><CardContent className="py-5">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{T.questionsCard}</h2>
            <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{task.questions}</p>
          </CardContent></Card>
        )}
        <ProbeInstructionCard task={task} onSaved={load} />
      </div>

      {task.is_builtin ? (
        <>
          {task.report && <DayReportView data={task.report} />}
          <DigestCard task={task} digesting={digesting} digestError={digestError} onTrigger={triggerDigest} />
          <MemberLinksCard task={task} copied={copied} copy={copy} resetLink={resetLink} />
        </>
      ) : (
        <>
          <DigestCard task={task} digesting={digesting} digestError={digestError} onTrigger={triggerDigest} />

          <Card>
            <CardContent className="py-5">
              <h2 className="mb-4 text-lg font-semibold">
                {T.participants}
                {task.type === 'recurring' && task.cycle_key ? (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {T.cycleFrom(task.cycle_key, isCurrentCycle)}
                  </span>
                ) : null}
              </h2>
              <div className="divide-y divide-border">
                {task.members.map((m) => (
                  <div key={m.member_id} className="py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-24 truncate font-medium">{m.name}</span>
                      {m.status === 'submitted'
                        ? <Badge className="bg-primary-soft text-primary border-transparent">{T.memberDone}</Badge>
                        : <Badge variant="secondary">{T.memberPending}</Badge>}
                      <code className="min-w-0 flex-1 truncate text-[0.85rem] text-muted-foreground max-sm:hidden">{m.link}</code>
                      <div className="ml-auto flex gap-1">
                        <Button variant="ghost" size="icon" title={T.copyTaskLink(m.name)} onClick={() => copy(m.member_id, m.link)}>
                          {copied === m.member_id ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" title={T.openTaskLink(m.name)} asChild>
                          <a href={m.link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
                        </Button>
                        <ResetLinkButton member={m} onReset={resetLink} />
                        {(m.summary.length > 0 || m.transcript) && (
                          <Button variant="ghost" size="icon" title={T.expandSummary} onClick={() => toggleExpand(m.member_id)}>
                            {expanded.has(m.member_id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </Button>
                        )}
                      </div>
                    </div>
                    {expanded.has(m.member_id) && (
                      <div className="mt-3 space-y-3 rounded-md bg-accent/50 px-4 py-3 text-[0.9rem] leading-relaxed">
                        {m.summary.length > 0 && (
                          <div>
                            <p className="mb-1 font-medium text-muted-foreground">{T.keyPoints}</p>
                            <ul className="list-disc space-y-1 pl-5">{m.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                          </div>
                        )}
                        {m.highlights.length > 0 && (
                          <div>
                            <p className="mb-1 font-medium text-muted-foreground">{T.keySignals}</p>
                            <ul className="list-disc space-y-1 pl-5">{m.highlights.map((s, i) => <li key={i}>{s}</li>)}</ul>
                          </div>
                        )}
                        {m.transcript && (
                          <details>
                            <summary className="cursor-pointer font-medium text-muted-foreground">{T.transcriptLabel(m.duration_s ? Math.round(m.duration_s / 60) : null)}</summary>
                            <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{m.transcript}</p>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function CycleSwitcher({ task, onSelect }) {
  const T = useLangDict(DICT);
  const cycles = task.cycles || [];
  if (!cycles.length) return null;
  return (
    <div className="mt-4 flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{T.cycleLabel}</span>
      <select
        value={task.cycle_key || ''}
        onChange={(e) => onSelect(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {cycles.map((c) => (
          <option key={c} value={c}>
            {c}{c === task.current_cycle_key ? T.currentCycleSuffix : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

// per-member link rotation with confirm — the old link dies immediately
function ResetLinkButton({ member, onReset }) {
  const T = useLangDict(DICT);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" title={T.resetLinkTitle(member.name)}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.resetLinkConfirm(member.name)}</AlertDialogTitle>
          <AlertDialogDescription>
            {T.resetLinkDesc}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onReset(member)}>{T.resetLink}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Built-in daily: member links live on the task now (v0.7 task×member model)
function MemberLinksCard({ task, copied, copy, resetLink }) {
  const T = useLangDict(DICT);
  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-1 text-lg font-semibold">{T.memberLinks}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{T.memberLinksDesc}</p>
        <div className="divide-y divide-border">
          {task.members.map((m) => (
            <div key={m.member_id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="w-24 truncate font-medium">{m.name}</span>
              {m.status === 'submitted'
                ? <Badge className="bg-primary-soft text-primary border-transparent">{T.reported}</Badge>
                : <Badge variant="secondary">{T.notReported}</Badge>}
              <code className="min-w-0 flex-1 truncate text-[0.85rem] text-muted-foreground max-sm:hidden">{m.link || '—'}</code>
              {m.link && (
                <div className="ml-auto flex gap-1">
                  <Button variant="ghost" size="icon" title={T.copyLink(m.name)} onClick={() => copy(m.member_id, m.link)}>
                    {copied === m.member_id ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="icon" title={T.openLink(m.name)} asChild>
                    <a href={m.link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
                  </Button>
                  <ResetLinkButton member={m} onReset={resetLink} />
                </div>
              )}
            </div>
          ))}
        </div>
        {task.test_member?.link && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border-strong px-4 py-3">
            <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <span className="text-sm font-medium">{T.testLink}</span>
            <span className="text-sm text-muted-foreground max-sm:hidden">{T.testLinkDesc}</span>
            <code className="min-w-0 flex-1 truncate text-[0.85rem] text-muted-foreground max-sm:hidden">{task.test_member.link}</code>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="icon" title={T.copyTestLink} onClick={() => copy('test', task.test_member.link)}>
                {copied === 'test' ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" title={T.openTestLink} asChild>
                <a href={task.test_member.link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Task-level 追问指引 — scenario-specific follow-up strategy layered on top of
// the global brain guidance. Editable here so the built-in daily task (which
// has no create form) can set it too.
function ProbeInstructionCard({ task, onSaved }) {
  const T = useLangDict(DICT);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(task.probe_instruction || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const has = Boolean((task.probe_instruction || '').trim());

  const onOpenChange = (next) => {
    if (next) { setValue(task.probe_instruction || ''); setErr(''); }
    setOpen(next);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await api(`api/tasks/${task.id}`, { method: 'PUT', body: { probe_instruction: value } });
      setOpen(false);
      onSaved();
    } catch (e) {
      if (e.status !== 401) setErr(T.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{T.probeCardTitle}</h2>
          <AlertDialog open={open} onOpenChange={onOpenChange}>
            <Button
              variant="ghost"
              size="icon"
              title={has ? T.probeEdit : T.probeSet}
              aria-label={T.probeEdit}
              className={cn('ml-auto -my-1 shrink-0', has && 'text-primary')}
              onClick={() => onOpenChange(true)}
            >
              <NotebookPen strokeWidth={1.75} />
            </Button>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{T.probeDialogTitle(task.title)}</AlertDialogTitle>
                <AlertDialogDescription>
                  {T.probeDialogDesc}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={T.probePh}
                rows={6}
                className={TEXTAREA_CLASS}
              />
              {err ? <p className="-mt-1 text-sm text-destructive">{err}</p> : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>{T.cancel}</AlertDialogCancel>
                <Button className="h-[34px] px-4" disabled={busy} onClick={save}>
                  {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                  {T.save}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {has
          ? <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{task.probe_instruction}</p>
          : <p className="text-sm text-faint">{T.probeUnset}</p>}
      </CardContent>
    </Card>
  );
}

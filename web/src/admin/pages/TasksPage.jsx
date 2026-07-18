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
import DayReportView from './DayReportView';

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

const statusBadge = (task) =>
  task.status === 'open'
    ? <Badge className="bg-primary-soft text-primary border-transparent">进行中</Badge>
    : <Badge variant="secondary">已关闭</Badge>;

const typeBadge = (task) => task.type === 'recurring'
  ? (
    <Badge variant="secondary" className="gap-1">
      <Repeat className="h-3 w-3" strokeWidth={2} />
      {task.is_builtin ? '内置 · ' : ''}{task.cadence_label || '循环'}
    </Badge>
  )
  : <Badge variant="secondary">一次性</Badge>;

/* ---------------- list + create ---------------- */

export function TasksPage() {
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
  if (data.error) return <p className="pt-10 text-center text-muted-foreground">加载失败，请刷新重试</p>;

  const recurring = data.tasks.filter((t) => t.type === 'recurring');
  const oneshots = data.tasks.filter((t) => t.type === 'oneshot');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">沟通任务</h1>
          <p className="mt-2 text-muted-foreground">代表负责人与成员做一对一语音沟通：循环任务按周期收汇报，一次性任务按主题发起</p>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" strokeWidth={2} />新建任务
        </Button>
      </div>

      {creating && <CreateTaskCard onDone={() => { setCreating(false); load(); }} />}

      {recurring.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-muted-foreground">循环任务</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {recurring.map((t) => <TaskCard key={t.id} task={t} progressLabel="本期" />)}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">一次性任务</h2>
        {oneshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有一次性任务。点「新建任务」发起一轮一对一沟通（如季度复盘、规划前置沟通）。</p>
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
  return (
    <Card className="cursor-pointer transition-colors hover:border-ring" onClick={() => navigate(`#/tasks/${task.id}`)}>
      <CardContent className="py-5">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-semibold">{task.title}</span>
          <div className="flex shrink-0 items-center gap-2">
            {typeBadge(task)}
            {statusBadge(task)}
          </div>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {progressLabel ? `${progressLabel} ` : ''}{task.submitted_count}/{task.member_count} 人已完成
          {task.type === 'recurring' && task.cycle_key ? ` · 本期始于 ${task.cycle_key}` : ''}
          {task.deadline ? ` · 截止 ${task.deadline}` : ''}
        </p>
      </CardContent>
    </Card>
  );
}

const DOW_OPTIONS = [
  { v: 1, label: '一' }, { v: 2, label: '二' }, { v: 3, label: '三' }, { v: 4, label: '四' },
  { v: 5, label: '五' }, { v: 6, label: '六' }, { v: 7, label: '日' },
];

function CreateTaskCard({ onDone }) {
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
    }).catch(() => setError('成员列表加载失败'));
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
    if (!title.trim()) return setError('请填写任务标题');
    if (!selected.size) return setError('请至少选择一位成员');
    if (type === 'recurring' && cadence === 'weekly' && !dows.size) return setError('每周任务请至少选择一个周几');
    const everyN = Number(every);
    if (type === 'recurring' && cadence === 'interval' && (!Number.isInteger(everyN) || everyN < 1 || everyN > 365)) {
      return setError('自定义间隔请填 1-365 的天数');
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
      setError('创建失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-5 py-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">任务类型</label>
          <div className="flex gap-2">
            {[['oneshot', '一次性'], ['recurring', '循环']].map(([v, label]) => (
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
            <label className="text-sm font-medium">周期</label>
            <div className="flex flex-wrap gap-2">
              {[['daily', '每天'], ['weekly', '每周'], ['interval', '每 N 天']].map(([v, label]) => (
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
                <span className="text-sm text-muted-foreground">周</span>
                {DOW_OPTIONS.map((d) => (
                  <button key={d.v} type="button" onClick={() => toggleDow(d.v)}
                    className={cn('h-9 w-9 rounded-full border text-sm transition-colors',
                      dows.has(d.v)
                        ? 'border-transparent bg-primary-soft text-primary font-medium'
                        : 'border-border text-muted-foreground hover:border-ring')}>
                    {d.label}
                  </button>
                ))}
              </div>
            )}
            {cadence === 'interval' && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">每</span>
                <Input type="number" min="1" max="365" value={every} onChange={(e) => setEvery(e.target.value)} className="w-20" />
                <span className="text-muted-foreground">天一个周期，从今天开始</span>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">任务标题</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder={type === 'recurring' ? '如：团队周报' : '如：Q2 复盘一对一沟通'} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">任务背景（brief，agent 用它开场和把握上下文）</label>
          <textarea className={TEXTAREA_CLASS} rows={4} value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder="给 agent 的背景说明：为什么发起这轮沟通、负责人关心什么…" />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">问题框架（要聊清楚的要点，自由文本）</label>
          <textarea className={TEXTAREA_CLASS} rows={4} value={questions} onChange={(e) => setQuestions(e.target.value)}
            placeholder={'- 这个季度你觉得做得最好和最遗憾的事\n- 团队协作里最卡的环节\n- 下季度最想推进的一件事'} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">追问指引（可选，叠加在大脑的通用追问指引之上）</label>
          <textarea className={TEXTAREA_CLASS} rows={3} value={probeInstruction} onChange={(e) => setProbeInstruction(e.target.value)}
            placeholder={'这次沟通要重点追什么、追到什么深度。例如：\n- 提到延期时，追问影响面和新的时间点\n- 只聊结论不聊过程时，追一个具体例子'} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">汇总 instruction（可选，不填用默认模板）</label>
          <textarea className={TEXTAREA_CLASS} rows={3} value={digestInstruction} onChange={(e) => setDigestInstruction(e.target.value)}
            placeholder={type === 'recurring'
              ? '默认模板：进展要点 / 共性主题 / 重点信号。想换个结构或口径就写在这里。'
              : '默认模板：共识 / 分歧 / 重点信号。想换个结构或口径就写在这里。'} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">参与成员（每人会生成该任务专属链接）</label>
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
              <label className="text-sm font-medium">截止日期（可选）</label>
              <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="w-44" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">自动生成汇总时间（可选，默认手工触发）</label>
              <Input type="datetime-local" value={autoAt} onChange={(e) => setAutoAt(e.target.value)} className="w-56" />
            </div>
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" checked={closeLinked} onChange={(e) => setCloseLinked(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
              生成汇总时自动关闭任务
            </label>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onDone}>取消</Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}创建任务
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------------- detail ---------------- */

export function TaskDetailPage({ id, cycle }) {
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
  if (task.error) return <p className="pt-10 text-center text-muted-foreground">任务不存在或加载失败</p>;

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
      setDigestError(err.status === 409 ? '这一期还没有人完成对话，暂无内容可汇总' : '汇总生成失败，请重试');
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
          <ArrowLeft className="h-4 w-4" />返回任务列表
        </a>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{task.title}</h1>
          {typeBadge(task)}
          {statusBadge(task)}
          <span className="text-sm text-muted-foreground">
            {task.type === 'recurring' ? '本期 ' : ''}{task.submitted_count}/{task.member_count} 人已完成
            {task.deadline ? ` · 截止 ${task.deadline}` : ''}
          </span>
          <div className="ml-auto flex gap-2">
            {task.status === 'open'
              ? <Button variant="outline" size="sm" onClick={() => setStatus('close')}><CircleCheck className="h-4 w-4" />{task.is_builtin ? '停用日报' : '关闭任务'}</Button>
              : <Button variant="outline" size="sm" onClick={() => setStatus('reopen')}><RotateCcw className="h-4 w-4" />重新打开</Button>}
            {!task.is_builtin && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="text-destructive"><Trash2 className="h-4 w-4" />删除</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除任务「{task.title}」？</AlertDialogTitle>
                    <AlertDialogDescription>任务、成员链接和已收集的对话小结都会删除，不可恢复。</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={remove} className="bg-destructive text-white hover:bg-destructive/90">删除</AlertDialogAction>
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
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">任务背景</h2>
            <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{task.brief}</p>
          </CardContent></Card>
        )}
        {task.questions && (
          <Card><CardContent className="py-5">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">问题框架</h2>
            <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{task.questions}</p>
          </CardContent></Card>
        )}
        <ProbeInstructionCard task={task} onSaved={load} />
      </div>

      {task.is_builtin ? (
        <>
          {task.report && <DayReportView data={task.report} />}
          <MemberLinksCard task={task} copied={copied} copy={copy} resetLink={resetLink} />
        </>
      ) : (
        <>
          <Card>
            <CardContent className="py-5">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">{task.type === 'recurring' ? '本期汇总' : '任务汇总'}</h2>
                <span className="text-sm text-muted-foreground">
                  {task.digest_updated_at
                    ? `更新于 ${task.digest_updated_at.slice(0, 16)} · 重新生成会覆盖`
                    : task.type === 'recurring' ? '周期结束自动生成，也可随时手工触发' : '默认手工触发，可随时生成'}
                  {task.digest_auto_at ? ` · 已设自动生成 ${task.digest_auto_at.slice(0, 16)}${task.digest_close_linked ? '（生成后自动关闭）' : ''}` : ''}
                  {task.digest_instruction ? ' · 已自定义汇总 instruction' : ''}
                </span>
                <Button size="sm" className="ml-auto" onClick={triggerDigest} disabled={digesting}>
                  {digesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {task.digest ? '重新生成汇总' : '生成汇总'}
                </Button>
              </div>
              {digestError && <p className="mb-3 text-sm text-destructive">{digestError}</p>}
              {task.digest
                ? <div className="whitespace-pre-wrap rounded-md bg-accent/50 px-4 py-3 text-[0.95rem] leading-relaxed">{task.digest}</div>
                : <p className="text-sm text-muted-foreground">尚未生成。成员完成对话后点「生成汇总」{task.digest_instruction ? '，按自定义 instruction 输出。' : task.type === 'recurring' ? '，输出进展要点 / 共性主题 / 重点信号。' : '，输出共识 / 分歧 / 重点信号。'}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-5">
              <h2 className="mb-4 text-lg font-semibold">
                参与成员
                {task.type === 'recurring' && task.cycle_key ? (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {task.cycle_key} 起的这一期{isCurrentCycle ? '（本期）' : ''}
                  </span>
                ) : null}
              </h2>
              <div className="divide-y divide-border">
                {task.members.map((m) => (
                  <div key={m.member_id} className="py-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="w-24 truncate font-medium">{m.name}</span>
                      {m.status === 'submitted'
                        ? <Badge className="bg-primary-soft text-primary border-transparent">已完成</Badge>
                        : <Badge variant="secondary">待沟通</Badge>}
                      <code className="min-w-0 flex-1 truncate text-[0.85rem] text-muted-foreground max-sm:hidden">{m.link}</code>
                      <div className="ml-auto flex gap-1">
                        <Button variant="ghost" size="icon" title={`复制 ${m.name} 的任务链接`} onClick={() => copy(m.member_id, m.link)}>
                          {copied === m.member_id ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" title={`打开 ${m.name} 的任务链接`} asChild>
                          <a href={m.link} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
                        </Button>
                        <ResetLinkButton member={m} onReset={resetLink} />
                        {(m.summary.length > 0 || m.transcript) && (
                          <Button variant="ghost" size="icon" title="展开小结" onClick={() => toggleExpand(m.member_id)}>
                            {expanded.has(m.member_id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </Button>
                        )}
                      </div>
                    </div>
                    {expanded.has(m.member_id) && (
                      <div className="mt-3 space-y-3 rounded-md bg-accent/50 px-4 py-3 text-[0.9rem] leading-relaxed">
                        {m.summary.length > 0 && (
                          <div>
                            <p className="mb-1 font-medium text-muted-foreground">要点</p>
                            <ul className="list-disc space-y-1 pl-5">{m.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                          </div>
                        )}
                        {m.highlights.length > 0 && (
                          <div>
                            <p className="mb-1 font-medium text-muted-foreground">重点信号</p>
                            <ul className="list-disc space-y-1 pl-5">{m.highlights.map((s, i) => <li key={i}>{s}</li>)}</ul>
                          </div>
                        )}
                        {m.transcript && (
                          <details>
                            <summary className="cursor-pointer font-medium text-muted-foreground">原始对话（{m.duration_s ? `${Math.round(m.duration_s / 60)} 分钟` : '—'}）</summary>
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
  const cycles = task.cycles || [];
  if (!cycles.length) return null;
  return (
    <div className="mt-4 flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">周期</span>
      <select
        value={task.cycle_key || ''}
        onChange={(e) => onSelect(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {cycles.map((c) => (
          <option key={c} value={c}>
            {c}{c === task.current_cycle_key ? '（本期）' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

// per-member link rotation with confirm — the old link dies immediately
function ResetLinkButton({ member, onReset }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" title={`重置 ${member.name} 的任务链接`}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>重置「{member.name}」的任务链接？</AlertDialogTitle>
          <AlertDialogDescription>
            会生成一个新链接，旧链接立即失效。新链接会自动复制到剪贴板。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction onClick={() => onReset(member)}>重置链接</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Built-in daily: member links live on the task now (v0.7 task×member model)
function MemberLinksCard({ task, copied, copy, resetLink }) {
  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="mb-1 text-lg font-semibold">成员链接</h2>
        <p className="mb-4 text-sm text-muted-foreground">每位成员用自己的任务专属链接进入语音汇报；任务停用后链接即失效</p>
        <div className="divide-y divide-border">
          {task.members.map((m) => (
            <div key={m.member_id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="w-24 truncate font-medium">{m.name}</span>
              {m.status === 'submitted'
                ? <Badge className="bg-primary-soft text-primary border-transparent">已汇报</Badge>
                : <Badge variant="secondary">待汇报</Badge>}
              <code className="min-w-0 flex-1 truncate text-[0.85rem] text-muted-foreground max-sm:hidden">{m.link || '—'}</code>
              {m.link && (
                <div className="ml-auto flex gap-1">
                  <Button variant="ghost" size="icon" title={`复制 ${m.name} 的链接`} onClick={() => copy(m.member_id, m.link)}>
                    {copied === m.member_id ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="icon" title={`打开 ${m.name} 的链接`} asChild>
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
            <span className="text-sm font-medium">体验链接</span>
            <span className="text-sm text-muted-foreground max-sm:hidden">任何人可用它体验语音对话，内容不计入正式汇报</span>
            <code className="min-w-0 flex-1 truncate text-[0.85rem] text-muted-foreground max-sm:hidden">{task.test_member.link}</code>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="icon" title="复制体验链接" onClick={() => copy('test', task.test_member.link)}>
                {copied === 'test' ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" title="打开体验链接" asChild>
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
      if (e.status !== 401) setErr('保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">追问指引（本任务）</h2>
          <AlertDialog open={open} onOpenChange={onOpenChange}>
            <Button
              variant="ghost"
              size="icon"
              title={has ? '编辑本任务的追问指引' : '设置本任务的追问指引'}
              aria-label="编辑本任务的追问指引"
              className={cn('ml-auto -my-1 shrink-0', has && 'text-primary')}
              onClick={() => onOpenChange(true)}
            >
              <NotebookPen strokeWidth={1.75} />
            </Button>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>「{task.title}」的追问指引</AlertDialogTitle>
                <AlertDialogDescription>
                  写这次沟通要重点追什么、追到什么深度。叠加在大脑的通用追问指引之上生效，只作用于这个任务，改动即时生效。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={'例如：\n- 提到延期时，追问影响面和新的时间点\n- 只聊结论不聊过程时，追一个具体例子'}
                rows={6}
                className={TEXTAREA_CLASS}
              />
              {err ? <p className="-mt-1 text-sm text-destructive">{err}</p> : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
                <Button className="h-[34px] px-4" disabled={busy} onClick={save}>
                  {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
                  保存
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {has
          ? <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed">{task.probe_instruction}</p>
          : <p className="text-sm text-faint">未设置——只用大脑里的通用追问指引</p>}
      </CardContent>
    </Card>
  );
}

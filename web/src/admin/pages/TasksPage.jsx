import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardList, Plus, Loader2, Copy, Check, ExternalLink, Sparkles,
  ChevronDown, ChevronRight, ArrowLeft, Trash2, CircleCheck, RotateCcw,
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

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

const statusBadge = (task) =>
  task.status === 'open'
    ? <Badge className="bg-primary-soft text-primary border-transparent">进行中</Badge>
    : <Badge variant="secondary">已关闭</Badge>;

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

  const daily = data.tasks.find((t) => t.type === 'recurring');
  const oneshots = data.tasks.filter((t) => t.type === 'oneshot');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">沟通任务</h1>
          <p className="mt-2 text-muted-foreground">代表负责人与成员做一对一语音沟通：日报是内置循环任务，一次性任务按主题发起</p>
        </div>
        <Button onClick={() => setCreating((v) => !v)}>
          <Plus className="h-4 w-4" strokeWidth={2} />新建任务
        </Button>
      </div>

      {creating && <CreateTaskCard onDone={() => { setCreating(false); load(); }} />}

      {daily && (
        <Card className="cursor-pointer transition-colors hover:border-ring" onClick={() => navigate('#/')}>
          <CardContent className="flex items-center gap-4 py-5">
            <ClipboardList className="h-5 w-5 text-primary" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <span className="font-semibold">{daily.title}</span>
                <Badge variant="secondary">内置 · 每日循环</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">今日 {daily.submitted_count}/{daily.member_count} 已汇报 · 成员用各自常驻链接参与，详情见「管理」和「今日报告」</p>
            </div>
            <ChevronRight className="h-5 w-5 text-faint" />
          </CardContent>
        </Card>
      )}

      {oneshots.length === 0 && (
        <p className="pt-4 text-center text-sm text-muted-foreground">还没有一次性任务。点「新建任务」发起一轮一对一沟通（如季度复盘、规划前置沟通）。</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {oneshots.map((t) => (
          <Card key={t.id} className="cursor-pointer transition-colors hover:border-ring" onClick={() => navigate(`#/tasks/${t.id}`)}>
            <CardContent className="py-5">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-semibold">{t.title}</span>
                {statusBadge(t)}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {t.submitted_count}/{t.member_count} 人已完成
                {t.digest_updated_at ? ` · 汇总更新于 ${t.digest_updated_at.slice(0, 16)}` : ' · 尚未生成汇总'}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CreateTaskCard({ onDone }) {
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [questions, setQuestions] = useState('');
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

  const submit = async () => {
    setError('');
    if (!title.trim()) return setError('请填写任务标题');
    if (!selected.size) return setError('请至少选择一位成员');
    setBusy(true);
    try {
      const body = { title: title.trim(), member_ids: [...selected] };
      if (brief.trim()) body.brief = brief.trim();
      if (questions.trim()) body.questions = questions.trim();
      if (deadline) body.deadline = deadline;
      if (autoAt) body.digest_auto_at = autoAt;
      body.digest_close_linked = closeLinked;
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
          <label className="text-sm font-medium">任务标题</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：Q2 复盘一对一沟通" />
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

export function TaskDetailPage({ id }) {
  const [task, setTask] = useState(null);
  const [digesting, setDigesting] = useState(false);
  const [digestError, setDigestError] = useState('');
  const [copied, setCopied] = useState(0);
  const [expanded, setExpanded] = useState(new Set());
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      setTask(await api(`api/tasks/${id}`));
    } catch (err) {
      if (err.status !== 401) setTask({ error: true });
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  if (task === null) {
    return <div className="flex justify-center pt-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (task.error) return <p className="pt-10 text-center text-muted-foreground">任务不存在或加载失败</p>;

  const copy = async (memberId, link) => {
    if (await copyText(link)) {
      setCopied(memberId);
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
      await api(`api/tasks/${id}/digest`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setDigestError(err.status === 409 ? '还没有人完成对话，暂无内容可汇总' : '汇总生成失败，请重试');
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
    navigate('#/tasks');
  };

  return (
    <div className="space-y-8">
      <div>
        <a href="#/tasks" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />返回任务列表
        </a>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{task.title}</h1>
          {statusBadge(task)}
          <span className="text-sm text-muted-foreground">{task.submitted_count}/{task.member_count} 人已完成{task.deadline ? ` · 截止 ${task.deadline}` : ''}</span>
          <div className="ml-auto flex gap-2">
            {task.status === 'open'
              ? <Button variant="outline" size="sm" onClick={() => setStatus('close')}><CircleCheck className="h-4 w-4" />关闭任务</Button>
              : <Button variant="outline" size="sm" onClick={() => setStatus('reopen')}><RotateCcw className="h-4 w-4" />重新打开</Button>}
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
          </div>
        </div>
      </div>

      {(task.brief || task.questions) && (
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
        </div>
      )}

      <Card>
        <CardContent className="py-5">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">任务汇总</h2>
            <span className="text-sm text-muted-foreground">
              {task.digest_updated_at ? `更新于 ${task.digest_updated_at.slice(0, 16)} · 重新生成会覆盖` : '默认手工触发，可随时生成'}
              {task.digest_auto_at ? ` · 已设自动生成 ${task.digest_auto_at.slice(0, 16)}${task.digest_close_linked ? '（生成后自动关闭）' : ''}` : ''}
            </span>
            <Button size="sm" className="ml-auto" onClick={triggerDigest} disabled={digesting}>
              {digesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {task.digest ? '重新生成汇总' : '生成汇总'}
            </Button>
          </div>
          {digestError && <p className="mb-3 text-sm text-destructive">{digestError}</p>}
          {task.digest
            ? <div className="whitespace-pre-wrap rounded-md bg-accent/50 px-4 py-3 text-[0.95rem] leading-relaxed">{task.digest}</div>
            : <p className="text-sm text-muted-foreground">尚未生成。成员完成对话后点「生成汇总」，输出共识 / 分歧 / 重点信号。</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-5">
          <h2 className="mb-4 text-lg font-semibold">参与成员</h2>
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
    </div>
  );
}

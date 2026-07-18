import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, UserCheck, Clock, Copy, Check, ExternalLink, RefreshCw, Trash2, Loader2, FlaskConical, NotebookPen } from 'lucide-react';
import { cn, copyText, today } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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

export default function RosterPage() {
  const [members, setMembers] = useState(null);
  const [testMember, setTestMember] = useState(null);
  const [reportDate, setReportDate] = useState('');
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const data = await api('api/members');
      setMembers(data.members || []);
      setTestMember(data.test_member || null);
      if (data.date) setReportDate(data.date);
    } catch (err) {
      if (err.status !== 401) setLoadError('加载失败，请刷新重试');
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearTimeout(copyTimer.current);
  }, [load]);

  const onCopy = async (m) => {
    const ok = await copyText(m.link);
    if (ok) {
      setCopiedId(m.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1600);
    }
  };

  const onAdd = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setAddError('');
    try {
      await api('api/members', { method: 'POST', body: { name: trimmed } });
      setName('');
      await load();
    } catch (err) {
      if (err.status === 409) setAddError(`成员「${trimmed}」已存在`);
      else if (err.status !== 401) setAddError('添加失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const onResetToken = async (m) => {
    try {
      const data = await api(`api/members/${m.id}/reset-token`, { method: 'POST' });
      setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, link: data.link } : x)));
      // put the fresh link straight on the clipboard
      const ok = await copyText(data.link);
      if (ok) {
        setCopiedId(m.id);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopiedId(null), 1600);
      }
    } catch (err) {
      if (err.status !== 401) setLoadError('重置链接失败，请重试');
    }
  };

  const onRemove = async (m) => {
    try {
      await api(`api/members/${m.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      if (err.status !== 401) setLoadError('移除失败，请重试');
    }
  };

  if (members === null) {
    return <p className="text-sm text-muted-foreground">{loadError || '加载中…'}</p>;
  }

  const total = members.length;
  const done = members.filter((m) => m.reported_today).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <p className="mb-2 text-sm font-medium text-muted-foreground">今天 {reportDate || today()}</p>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">成员管理</h1>
      <p className="mt-3 text-base text-muted-foreground">每位成员通过自己的专属链接和 Luna 语音汇报</p>

      {/* stat tiles */}
      <div className="mt-8 grid grid-cols-3 gap-4 max-sm:grid-cols-1">
        <StatTile icon={Users} label="成员" value={total} suffix="人" />
        <StatTile icon={UserCheck} label="已汇报" value={done} valueClass="text-success" />
        <StatTile icon={Clock} label="待汇报" value={total - done} />
      </div>

      {/* completion bar */}
      <div className="mt-4 flex items-center gap-4">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-accent">
          <div className="h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-sm font-semibold tabular-nums text-muted-foreground">今日完成 {pct}%</span>
      </div>

      {loadError ? <p className="mt-6 text-sm text-destructive">{loadError}</p> : null}

      {/* mobile: stacked member list — the full table doesn't fit a phone width */}
      <Card className="mt-8 sm:hidden">
        <CardContent className="px-4 py-1">
          {members.length === 0 ? (
            <p className="py-4 text-sm text-faint">暂无成员，先在下方添加</p>
          ) : (
            <div className="divide-y divide-border">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-1 py-3">
                  <div className="min-w-0 flex-1 pr-2">
                    <p className="truncate text-[0.95rem] font-semibold">{m.name}</p>
                    <p className="mt-1.5">
                      {m.reported_today ? <Badge variant="success">已汇报</Badge> : <Badge>待汇报</Badge>}
                    </p>
                  </div>
                  <LinkButtons m={m} copiedId={copiedId} onCopy={onCopy} />
                  <span className="mx-1 h-4 w-px shrink-0 bg-border" />
                  <MemberRowActions
                    m={m}
                    onSaved={(patch) => setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, ...patch } : x)))}
                    onResetToken={onResetToken}
                    onRemove={onRemove}
                  />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-8 max-sm:hidden">
        <CardContent className="px-4 py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[0.85rem]">成员</TableHead>
                <TableHead className="text-[0.85rem]">专属语音链接</TableHead>
                <TableHead className="text-[0.85rem]">今日状态</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-faint">
                    暂无成员，先在下方添加
                  </TableCell>
                </TableRow>
              ) : (
                members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap py-4 text-[0.95rem] font-semibold">{m.name}</TableCell>
                    <TableCell className="py-4">
                      <div className="flex items-center gap-2">
                        <code className="max-w-[440px] truncate font-mono text-[0.8rem] text-muted-foreground max-lg:max-w-[280px]">
                          {m.link}
                        </code>
                        <LinkButtons m={m} copiedId={copiedId} onCopy={onCopy} />
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      {m.reported_today ? <Badge variant="success">已汇报</Badge> : <Badge>待汇报</Badge>}
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex items-center justify-end gap-0.5">
                        <MemberRowActions
                          m={m}
                          onSaved={(patch) =>
                            setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, ...patch } : x)))
                          }
                          onResetToken={onResetToken}
                          onRemove={onRemove}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* add member */}
      <form onSubmit={onAdd} className="mt-6 flex items-center gap-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新成员姓名"
          autoComplete="off"
          className="h-11 max-w-[300px] text-base"
        />
        <Button type="submit" className="h-11 px-6 text-[0.95rem]" disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
          添加成员
        </Button>
      </form>
      {addError ? <p className="mt-2 text-sm text-destructive">{addError}</p> : null}

      {/* built-in try-it link — separate from the roster, never counted */}
      {testMember ? (
        <Card className="mt-10">
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
              <FlaskConical className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[0.95rem] font-semibold">
                体验链接
                <span className="ml-2 text-[0.82rem] font-normal text-muted-foreground">
                  任何人可用它体验语音对话，内容不计入正式汇报和统计
                </span>
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 truncate font-mono text-[0.8rem] text-muted-foreground">{testMember.link}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  title="复制链接"
                  aria-label="复制体验链接"
                  className={cn(copiedId === testMember.id && 'text-success hover:text-success')}
                  onClick={() => onCopy(testMember)}
                >
                  {copiedId === testMember.id ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
                </Button>
                <Button asChild variant="ghost" size="icon" title="新标签页打开" aria-label="打开体验链接">
                  <a href={testMember.link} target="_blank" rel="noreferrer">
                    <ExternalLink strokeWidth={1.75} />
                  </a>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

// copy + open-in-new-tab pair, shared by the desktop table and the mobile list
function LinkButtons({ m, copiedId, onCopy }) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        title="复制链接"
        aria-label={`复制 ${m.name} 的链接`}
        className={cn('shrink-0', copiedId === m.id && 'text-success hover:text-success')}
        onClick={() => onCopy(m)}
      >
        {copiedId === m.id ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
      </Button>
      <Button asChild variant="ghost" size="icon" title="新标签页打开" aria-label={`打开 ${m.name} 的链接`} className="shrink-0">
        <a href={m.link} target="_blank" rel="noreferrer">
          <ExternalLink strokeWidth={1.75} />
        </a>
      </Button>
    </>
  );
}

// context/reset/remove action cluster, shared by the desktop table and the mobile list
function MemberRowActions({ m, onSaved, onResetToken, onRemove }) {
  return (
    <>
      <MemberContextButton member={m} onSaved={onSaved} />
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" title="重置链接" aria-label={`重置 ${m.name} 的链接`} className="shrink-0">
            <RefreshCw strokeWidth={1.75} />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重置「{m.name}」的专属链接？</AlertDialogTitle>
            <AlertDialogDescription>
              会生成一个新的专属链接，旧链接立即失效。适用于链接泄露或需要更换的情况。新链接会自动复制到剪贴板。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => onResetToken(m)}>重置链接</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            title="移除成员"
            aria-label={`移除成员 ${m.name}`}
            className="shrink-0 hover:bg-destructive-soft hover:text-destructive"
          >
            <Trash2 strokeWidth={1.75} />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除成员「{m.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              历史日报会保留，专属链接立即失效。之后可以重新添加同名成员（历史记录会关联回来）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onRemove(m)}>
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const textareaCls =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

// Per-member brain dialog: human-written 背景 (injected as 【关于 X】) plus the
// auto-maintained 动态画像 (merged from past reports after each standup, hand-
// correctable here). A filled icon marks members that have either.
function MemberContextButton({ member, onSaved }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(member.context || '');
  const [profile, setProfile] = useState(member.profile || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const has = Boolean((member.context || '').trim() || (member.profile || '').trim());

  const onOpenChange = (next) => {
    if (next) { setValue(member.context || ''); setProfile(member.profile || ''); setErr(''); }
    setOpen(next);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      const patch = {};
      if (value !== (member.context || '')) {
        const r = await api(`api/members/${member.id}/context`, { method: 'PUT', body: { context: value } });
        patch.context = r.context || '';
      }
      // only touch the profile when hand-edited — keeps profile_updated_at honest
      if (profile !== (member.profile || '')) {
        const r = await api(`api/members/${member.id}/profile`, { method: 'PUT', body: { profile } });
        patch.profile = r.profile || '';
      }
      onSaved(patch);
      setOpen(false);
    } catch (e) {
      if (e.status !== 401) setErr('保存失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <Button
        variant="ghost"
        size="icon"
        title={has ? '编辑背景/画像' : '添加背景/画像'}
        aria-label={`${member.name} 的背景与画像`}
        className={cn(has && 'text-primary')}
        onClick={() => onOpenChange(true)}
      >
        <NotebookPen strokeWidth={1.75} />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>「{member.name}」的背景与画像</AlertDialogTitle>
          <AlertDialogDescription>
            两部分都会在语音汇报时注入给助手：背景由你维护；动态画像在每次汇报后自动更新，也可以在这里手动修正。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div>
          <p className="mb-1.5 text-sm font-medium">基础背景 / 关注点</p>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="例如：前端负责人，正在做发布系统；重点关注上线节奏和回归测试覆盖。"
            rows={4}
            className={textareaCls}
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">
            动态画像
            <span className="ml-2 font-normal text-muted-foreground">
              {member.profile_updated_at ? `自动更新于 ${member.profile_updated_at}` : '汇报后自动生成'}
            </span>
          </p>
          <textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="这位同事完成语音汇报后，助手会自动在这里整理出他的角色、项目脉络和持续关注点。"
            rows={6}
            className={textareaCls}
          />
        </div>
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
  );
}

function StatTile({ icon: Icon, label, value, suffix, valueClass }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between px-6 py-5">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className={cn('mt-2 text-[2.75rem] font-bold leading-none tracking-tight tabular-nums', valueClass)}>
            {value}
            {suffix ? <span className="ml-1.5 text-base font-medium text-muted-foreground">{suffix}</span> : null}
          </p>
        </div>
        <Icon className="h-9 w-9 text-border-strong" strokeWidth={1.5} />
      </CardContent>
    </Card>
  );
}

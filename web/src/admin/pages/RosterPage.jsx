import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, UserCheck, Clock, Copy, Check, ExternalLink, RefreshCw, Trash2, Loader2 } from 'lucide-react';
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

      <Card className="mt-8">
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
                        <Button
                          variant="ghost"
                          size="icon"
                          title="复制链接"
                          aria-label={`复制 ${m.name} 的链接`}
                          className={cn(copiedId === m.id && 'text-success hover:text-success')}
                          onClick={() => onCopy(m)}
                        >
                          {copiedId === m.id ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
                        </Button>
                        <Button asChild variant="ghost" size="icon" title="新标签页打开" aria-label={`打开 ${m.name} 的链接`}>
                          <a href={m.link} target="_blank" rel="noreferrer">
                            <ExternalLink strokeWidth={1.75} />
                          </a>
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      {m.reported_today ? <Badge variant="success">已汇报</Badge> : <Badge>待汇报</Badge>}
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex items-center justify-end gap-0.5">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" title="重置链接" aria-label={`重置 ${m.name} 的链接`}>
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
                              className="hover:bg-destructive-soft hover:text-destructive"
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
    </>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, UserCheck, Copy, Check, RefreshCw, Trash2, Loader2 } from 'lucide-react';
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

  const done = members.filter((m) => m.reported_today).length;

  return (
    <>
      <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold">成员管理</h1>
      <p className="mb-5 text-sm text-muted-foreground">今天 {reportDate || today()} · 每位成员通过自己的专属链接和 Luna 语音汇报</p>

      {/* stat chips */}
      <div className="mb-4 flex flex-wrap gap-2.5">
        <StatChip icon={Users} label="成员" value={members.length} suffix="人" />
        <StatChip icon={UserCheck} label="已汇报" value={done} valueClass="text-success" />
        <StatChip icon={Users} label="待汇报" value={members.length - done} />
      </div>

      {loadError ? <p className="mb-3 text-sm text-destructive">{loadError}</p> : null}

      <Card className="mb-4">
        <CardContent className="px-2 py-1.5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>专属语音链接</TableHead>
                <TableHead>今日状态</TableHead>
                <TableHead className="w-16" />
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
                    <TableCell className="whitespace-nowrap font-medium">{m.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <code className="max-w-[320px] truncate font-mono text-xs text-muted-foreground">{m.link}</code>
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
                      </div>
                    </TableCell>
                    <TableCell>
                      {m.reported_today ? <Badge variant="success">已汇报</Badge> : <Badge>待汇报</Badge>}
                    </TableCell>
                    <TableCell>
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
      <form onSubmit={onAdd} className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="新成员姓名"
          autoComplete="off"
          className="max-w-[260px]"
        />
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
          添加成员
        </Button>
      </form>
      {addError ? <p className="mt-2 text-sm text-destructive">{addError}</p> : null}
    </>
  );
}

function StatChip({ icon: Icon, label, value, suffix, valueClass }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-card px-3.5 py-[5px] text-[0.82rem] text-muted-foreground shadow-xs">
      <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
      {label}
      <b className={cn('text-[0.95rem] font-semibold text-foreground', valueClass)}>{value}</b>
      {suffix}
    </span>
  );
}

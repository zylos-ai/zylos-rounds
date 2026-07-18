import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, ExternalLink, Trash2, Loader2, FlaskConical, NotebookPen, Repeat } from 'lucide-react';
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

/**
 * 成员 module (v0.7): members are cross-task entities. This page owns the
 * roster (CRUD), each member's 基础背景 + 动态画像, and shows the per-task
 * links a member currently holds. Daily-standup status lives in the daily
 * task's detail page, not here.
 */
export default function MembersPage() {
  const [members, setMembers] = useState(null);
  const [testMember, setTestMember] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const data = await api('api/members');
      setMembers(data.members || []);
      setTestMember(data.test_member || null);
    } catch (err) {
      if (err.status !== 401) setLoadError('加载失败，请刷新重试');
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearTimeout(copyTimer.current);
  }, [load]);

  const onCopy = async (key, link) => {
    const ok = await copyText(link);
    if (ok) {
      setCopiedKey(key);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedKey(null), 1600);
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

  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">成员管理</h1>
      <p className="mt-3 text-base text-muted-foreground">
        成员是跨任务的实体：背景与动态画像随所有沟通任务持续积累。每个任务给成员发专属链接，链接在对应任务详情页管理。
      </p>

      {loadError ? <p className="mt-6 text-sm text-destructive">{loadError}</p> : null}

      <Card className="mt-8">
        <CardContent className="px-5 py-2 max-sm:px-4">
          {members.length === 0 ? (
            <p className="py-4 text-sm text-faint">暂无成员，先在下方添加</p>
          ) : (
            <div className="divide-y divide-border">
              {members.map((m) => (
                <div key={m.id} className="py-4">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[0.95rem] font-semibold">{m.name}</p>
                    <MemberContextButton
                      member={m}
                      onSaved={(patch) => setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, ...patch } : x)))}
                    />
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
                            历史记录会保留，该成员所有任务链接立即失效。之后可以重新添加同名成员（历史记录会关联回来）。
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
                  <MemberLinks member={m} copiedKey={copiedKey} onCopy={onCopy} />
                </div>
              ))}
            </div>
          )}
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

      {/* built-in try-it member — separate from the roster, never counted */}
      {testMember ? (
        <Card className="mt-10">
          <CardContent className="px-6 py-5">
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
                <FlaskConical className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <p className="text-[0.95rem] font-semibold">
                体验链接
                <span className="ml-2 text-[0.82rem] font-normal text-muted-foreground">
                  任何人可用它体验语音对话，内容不计入正式汇报和统计
                </span>
              </p>
            </div>
            <MemberLinks member={testMember} copiedKey={copiedKey} onCopy={onCopy} idPrefix="test" />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

// one row per open task the member holds a link for
function MemberLinks({ member, copiedKey, onCopy, idPrefix = '' }) {
  const links = member.links || [];
  if (!links.length) {
    return <p className="mt-2 text-sm text-faint">还没有任务链接（加入任务后自动生成）</p>;
  }
  return (
    <div className="mt-2 space-y-1.5">
      {links.map((l) => {
        const key = `${idPrefix}${member.id}:${l.task_id}`;
        return (
          <div key={l.task_id} className="flex items-center gap-2">
            <Badge variant="secondary" className="shrink-0 gap-1 font-normal">
              {l.type === 'recurring' && <Repeat className="h-3 w-3" strokeWidth={2} />}
              {l.title}
            </Badge>
            <code className="min-w-0 flex-1 truncate font-mono text-[0.8rem] text-muted-foreground">{l.link}</code>
            <Button
              variant="ghost"
              size="icon"
              title={`复制「${l.title}」链接`}
              aria-label={`复制 ${member.name} 的「${l.title}」链接`}
              className={cn('shrink-0', copiedKey === key && 'text-success hover:text-success')}
              onClick={() => onCopy(key, l.link)}
            >
              {copiedKey === key ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
            </Button>
            <Button asChild variant="ghost" size="icon" title="新标签页打开" aria-label={`打开 ${member.name} 的「${l.title}」链接`} className="shrink-0">
              <a href={l.link} target="_blank" rel="noreferrer">
                <ExternalLink strokeWidth={1.75} />
              </a>
            </Button>
          </div>
        );
      })}
    </div>
  );
}

const textareaCls =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

// Per-member brain dialog: human-written 背景 (injected as 【关于 X】) plus the
// auto-maintained 动态画像 (merged from past conversations across all tasks,
// hand-correctable here). A filled icon marks members that have either.
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
        className={cn('shrink-0', has && 'text-primary')}
        onClick={() => onOpenChange(true)}
      >
        <NotebookPen strokeWidth={1.75} />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>「{member.name}」的背景与画像</AlertDialogTitle>
          <AlertDialogDescription>
            两部分都会在每次语音沟通时注入给助手：背景由你维护；动态画像在每次对话后自动更新（所有任务共同喂养），也可以在这里手动修正。
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
              {member.profile_updated_at ? `自动更新于 ${member.profile_updated_at}` : '对话后自动生成'}
            </span>
          </p>
          <textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="这位同事完成语音沟通后，助手会自动在这里整理出他的角色、项目脉络和持续关注点。"
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, ExternalLink, Trash2, Loader2, FlaskConical, NotebookPen, Repeat, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
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
import { useLangDict } from '../i18n';

/**
 * 成员 module (v0.7): members are cross-task entities. This page owns the
 * roster (CRUD), each member's 基础背景 + 动态画像, and shows the per-task
 * links a member currently holds. Daily-standup status lives in the daily
 * task's detail page, not here.
 */
const PAGE_SIZE = 10;

const DICT = {
  zh: {
    loading: '加载中…',
    loadFailed: '加载失败，请刷新重试',
    title: '成员管理',
    intro: '成员是跨任务的实体：背景与动态画像随所有沟通任务持续积累。每个任务给成员发专属链接，链接在对应任务详情页管理。',
    memberCountFiltered: (shown, total) => `${shown} / ${total} 位成员`,
    memberCountTotal: (n) => `共 ${n} 位成员`,
    searchPlaceholder: '搜索成员',
    namePlaceholder: '新成员姓名',
    addMember: '添加成员',
    memberExists: (n) => `成员「${n}」已存在`,
    addFailed: '添加失败，请重试',
    emptyRoster: '暂无成员，先在右上方添加',
    noMatch: (q) => `没有名字含「${q}」的成员`,
    removeMemberTitle: '移除成员',
    removeMemberAria: (n) => `移除成员 ${n}`,
    removeConfirmTitle: (n) => `移除成员「${n}」？`,
    removeConfirmDesc: '历史记录会保留，该成员所有任务链接立即失效。之后可以重新添加同名成员（历史记录会关联回来）。',
    cancel: '取消',
    remove: '移除',
    removeFailed: '移除失败，请重试',
    prevPage: '上一页',
    nextPage: '下一页',
    pageOf: (p, total) => `第 ${p} / ${total} 页`,
    testTitle: '体验链接',
    testDesc: '任何人可用它体验语音对话，内容不计入正式汇报和统计',
    noLinks: '还没有任务链接（加入任务后自动生成）',
    linksCount: (n) => `${n} 个任务链接`,
    collapse: '收起',
    copyLinkTitle: (t) => `复制「${t}」链接`,
    copyLinkAria: (name, t) => `复制 ${name} 的「${t}」链接`,
    openLinkTitle: '新标签页打开',
    openLinkAria: (name, t) => `打开 ${name} 的「${t}」链接`,
    langTeamDefault: '跟随团队',
    langZh: '中文',
    langEn: 'English',
    langTitle: '该成员的汇报页和语音对话语言',
    saveFailed: '保存失败，请重试',
    editContext: '编辑背景/画像',
    addContext: '添加背景/画像',
    contextAria: (n) => `${n} 的背景与画像`,
    contextTitle: (n) => `「${n}」的背景与画像`,
    contextDesc: '两部分都会在每次语音沟通时注入给助手：背景由你维护；动态画像在每次对话后自动更新（所有任务共同喂养），也可以在这里手动修正。',
    contextLabel: '基础背景 / 关注点',
    contextPlaceholder: '例如：前端负责人，正在做发布系统；重点关注上线节奏和回归测试覆盖。',
    profileLabel: '动态画像',
    profileUpdatedAt: (d) => `自动更新于 ${d}`,
    profileAuto: '对话后自动生成',
    profilePlaceholder: '这位同事完成语音沟通后，助手会自动在这里整理出他的角色、项目脉络和持续关注点。',
    save: '保存',
  },
  en: {
    loading: 'Loading…',
    loadFailed: 'Failed to load — please refresh',
    title: 'Members',
    intro: 'Members are cross-task entities: their background and dynamic profile keep accumulating across all communication tasks. Each task issues members personal links, managed on that task\'s detail page.',
    memberCountFiltered: (shown, total) => `${shown} / ${total} members`,
    memberCountTotal: (n) => `${n} members total`,
    searchPlaceholder: 'Search members',
    namePlaceholder: 'New member name',
    addMember: 'Add member',
    memberExists: (n) => `Member "${n}" already exists`,
    addFailed: 'Failed to add — please try again',
    emptyRoster: 'No members yet — add one at the top right',
    noMatch: (q) => `No members whose name contains "${q}"`,
    removeMemberTitle: 'Remove member',
    removeMemberAria: (n) => `Remove member ${n}`,
    removeConfirmTitle: (n) => `Remove member "${n}"?`,
    removeConfirmDesc: 'History is kept, but all of this member\'s task links stop working immediately. You can re-add a member with the same name later (history will be linked back).',
    cancel: 'Cancel',
    remove: 'Remove',
    removeFailed: 'Failed to remove — please try again',
    prevPage: 'Previous page',
    nextPage: 'Next page',
    pageOf: (p, total) => `Page ${p} / ${total}`,
    testTitle: 'Try-it link',
    testDesc: 'Anyone can use it to try the voice conversation; nothing counts toward real reports or stats',
    noLinks: 'No task links yet (created automatically when the member joins a task)',
    linksCount: (n) => `${n} task links`,
    collapse: 'Collapse',
    copyLinkTitle: (t) => `Copy "${t}" link`,
    copyLinkAria: (name, t) => `Copy ${name}'s "${t}" link`,
    openLinkTitle: 'Open in new tab',
    openLinkAria: (name, t) => `Open ${name}'s "${t}" link`,
    langTeamDefault: 'Team default',
    langZh: 'Chinese',
    langEn: 'English',
    langTitle: 'This member\'s talk-page and voice conversation language',
    saveFailed: 'Save failed — please try again',
    editContext: 'Edit background/profile',
    addContext: 'Add background/profile',
    contextAria: (n) => `Background and profile of ${n}`,
    contextTitle: (n) => `Background & profile of "${n}"`,
    contextDesc: 'Both parts are injected into the assistant on every voice conversation: you maintain the background; the dynamic profile updates automatically after each conversation (fed by all tasks) and can also be corrected here by hand.',
    contextLabel: 'Background / focus areas',
    contextPlaceholder: 'e.g. Frontend lead, building the release system; focused on launch cadence and regression test coverage.',
    profileLabel: 'Dynamic profile',
    profileUpdatedAt: (d) => `Auto-updated ${d}`,
    profileAuto: 'Generated automatically after conversations',
    profilePlaceholder: 'After this member finishes a voice conversation, the assistant will summarize their role, project context, and ongoing focus here.',
    save: 'Save',
  },
};

export default function MembersPage() {
  const T = useLangDict(DICT);
  const [members, setMembers] = useState(null);
  const [testMember, setTestMember] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [addError, setAddError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const copyTimer = useRef(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const data = await api('api/members');
      setMembers(data.members || []);
      setTestMember(data.test_member || null);
    } catch (err) {
      if (err.status !== 401) setLoadError(T.loadFailed);
    }
  }, [T]);

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
      if (err.status === 409) setAddError(T.memberExists(trimmed));
      else if (err.status !== 401) setAddError(T.addFailed);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (m) => {
    try {
      await api(`api/members/${m.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      if (err.status !== 401) setLoadError(T.removeFailed);
    }
  };

  if (members === null) {
    return <p className="text-sm text-muted-foreground">{loadError || T.loading}</p>;
  }

  const q = query.trim().toLowerCase();
  const filtered = q ? members.filter((m) => m.name.toLowerCase().includes(q)) : members;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageMembers = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">{T.title}</h1>
      <p className="mt-3 text-base text-muted-foreground">
        {T.intro}
      </p>

      {loadError ? <p className="mt-6 text-sm text-destructive">{loadError}</p> : null}

      {/* search + add-member entry live at the top of the roster */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {q ? T.memberCountFiltered(filtered.length, members.length) : T.memberCountTotal(members.length)}
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
              placeholder={T.searchPlaceholder}
              autoComplete="off"
              className="h-9 w-[180px] pl-8 max-sm:w-[150px]"
            />
          </div>
        </div>
        <form onSubmit={onAdd} className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={T.namePlaceholder}
            autoComplete="off"
            className="h-9 w-[180px] max-sm:w-[150px]"
          />
          <Button type="submit" size="sm" className="h-9" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
            {T.addMember}
          </Button>
        </form>
      </div>
      {addError ? <p className="mt-2 text-right text-sm text-destructive">{addError}</p> : null}

      <Card className="mt-3">
        <CardContent className="px-5 py-2 max-sm:px-4">
          {members.length === 0 ? (
            <p className="py-4 text-sm text-faint">{T.emptyRoster}</p>
          ) : filtered.length === 0 ? (
            <p className="py-4 text-sm text-faint">{T.noMatch(query.trim())}</p>
          ) : (
            <div className="divide-y divide-border">
              {pageMembers.map((m) => (
                <div key={m.id} className="py-4">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[0.95rem] font-semibold">{m.name}</p>
                    <MemberLanguageSelect
                      member={m}
                      onSaved={(patch) => setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, ...patch } : x)))}
                      onError={() => setLoadError(T.saveFailed)}
                    />
                    <MemberContextButton
                      member={m}
                      onSaved={(patch) => setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, ...patch } : x)))}
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={T.removeMemberTitle}
                          aria-label={T.removeMemberAria(m.name)}
                          className="shrink-0 hover:bg-destructive-soft hover:text-destructive"
                        >
                          <Trash2 strokeWidth={1.75} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{T.removeConfirmTitle(m.name)}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {T.removeConfirmDesc}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => onRemove(m)}>
                            {T.remove}
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

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button variant="ghost" size="icon" aria-label={T.prevPage} disabled={safePage <= 1}
            onClick={() => setPage(safePage - 1)}>
            <ChevronLeft strokeWidth={1.75} />
          </Button>
          <span className="text-sm text-muted-foreground">{T.pageOf(safePage, totalPages)}</span>
          <Button variant="ghost" size="icon" aria-label={T.nextPage} disabled={safePage >= totalPages}
            onClick={() => setPage(safePage + 1)}>
            <ChevronRight strokeWidth={1.75} />
          </Button>
        </div>
      )}

      {/* built-in try-it member — separate from the roster, never counted */}
      {testMember ? (
        <Card className="mt-10">
          <CardContent className="px-6 py-5">
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
                <FlaskConical className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <p className="min-w-0 flex-1 text-[0.95rem] font-semibold">
                {T.testTitle}
                <span className="ml-2 text-[0.82rem] font-normal text-muted-foreground">
                  {T.testDesc}
                </span>
              </p>
              <MemberLanguageSelect
                member={testMember}
                onSaved={(patch) => setTestMember((tm) => (tm ? { ...tm, ...patch } : tm))}
                onError={() => setLoadError(T.saveFailed)}
              />
            </div>
            <MemberLinks member={testMember} copiedKey={copiedKey} onCopy={onCopy} idPrefix="test" />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

// Per-member conversation-language selector: '' follows the team default,
// 'zh'/'en' pin the member's talk page + voice conversation language.
function MemberLanguageSelect({ member, onSaved, onError }) {
  const T = useLangDict(DICT);
  const value = member.language || '';
  const onChange = async (e) => {
    const language = e.target.value;
    onSaved({ language });
    try {
      const r = await api(`api/members/${member.id}/language`, { method: 'PUT', body: { language } });
      onSaved({ language: r.language, language_effective: r.language_effective });
    } catch (err) {
      if (err.status !== 401) onError();
    }
  };
  return (
    <select
      value={value}
      onChange={onChange}
      title={T.langTitle}
      aria-label={T.langTitle}
      className={cn(
        'h-8 shrink-0 rounded-md border border-input bg-transparent px-2 text-sm transition-colors focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        value === '' ? 'text-muted-foreground' : 'text-foreground'
      )}
    >
      <option value="">{T.langTeamDefault}</option>
      <option value="zh">{T.langZh}</option>
      <option value="en">{T.langEn}</option>
    </select>
  );
}

// one row per open task the member holds a link for; more than two links
// collapse behind a toggle so long rosters stay scannable
function MemberLinks({ member, copiedKey, onCopy, idPrefix = '' }) {
  const T = useLangDict(DICT);
  const links = member.links || [];
  const [expanded, setExpanded] = useState(false);
  const collapsible = links.length > 2;
  if (!links.length) {
    return <p className="mt-2 text-sm text-faint">{T.noLinks}</p>;
  }
  if (collapsible && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mt-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
        {T.linksCount(links.length)}
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-1.5">
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
          {T.collapse}
        </button>
      )}
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
              title={T.copyLinkTitle(l.title)}
              aria-label={T.copyLinkAria(member.name, l.title)}
              className={cn('shrink-0', copiedKey === key && 'text-success hover:text-success')}
              onClick={() => onCopy(key, l.link)}
            >
              {copiedKey === key ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
            </Button>
            <Button asChild variant="ghost" size="icon" title={T.openLinkTitle} aria-label={T.openLinkAria(member.name, l.title)} className="shrink-0">
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
  const T = useLangDict(DICT);
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
      if (e.status !== 401) setErr(T.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <Button
        variant="ghost"
        size="icon"
        title={has ? T.editContext : T.addContext}
        aria-label={T.contextAria(member.name)}
        className={cn('shrink-0', has && 'text-primary')}
        onClick={() => onOpenChange(true)}
      >
        <NotebookPen strokeWidth={1.75} />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.contextTitle(member.name)}</AlertDialogTitle>
          <AlertDialogDescription>
            {T.contextDesc}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div>
          <p className="mb-1.5 text-sm font-medium">{T.contextLabel}</p>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={T.contextPlaceholder}
            rows={4}
            className={textareaCls}
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">
            {T.profileLabel}
            <span className="ml-2 font-normal text-muted-foreground">
              {member.profile_updated_at ? T.profileUpdatedAt(member.profile_updated_at) : T.profileAuto}
            </span>
          </p>
          <textarea
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder={T.profilePlaceholder}
            rows={6}
            className={textareaCls}
          />
        </div>
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
  );
}

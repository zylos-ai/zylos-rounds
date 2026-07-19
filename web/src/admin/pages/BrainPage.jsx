import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, MessageCircleQuestion, BookOpen, Loader2, Plus, Pencil, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
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

const DICT = {
  zh: {
    loading: '加载中…',
    loadFailed: '加载失败，请刷新重试',
    pageTitle: '大脑',
    pageIntro: '这里维护语音助手的全局「大脑」：团队背景和追问指引会在每次通话（所有任务）时注入给助手；知识库供助手在对话中按需检索。 任务级的 brief / 问题框架在各任务里维护，作用域只有那个任务，会叠加在这里的全局内容之上。改动即时生效，作用于下一次开始的通话。',
    teamBgTitle: '团队背景',
    teamBgHint: '团队在做什么、当前的重点。帮助助手听懂同事在说什么，不会被读出来。',
    teamBgPlaceholder: '例如：我们是 OpenMax 团队，正在做 AI agent 协作平台。当前重点是……',
    probingTitle: '追问指引',
    probingHint: '决定助手在什么情况下追问、追问什么、追问到什么程度。你关心什么，就写在这里。',
    probingPlaceholder: '例如：当对方说某事「基本完成」时，追问一句是否验证过……',
    saved: '已保存，下一次通话生效',
    saveFailed: '保存失败，请重试',
    save: '保存',
    kbTitle: '知识库',
    kbHint: '项目、名词、团队记忆等条目；助手在对话中判断需要时会检索这里',
    kbEmpty: '还没有知识条目，在下面添加第一条',
    edit: '编辑',
    editAria: (title) => `编辑 ${title}`,
    del: '删除',
    delAria: (title) => `删除 ${title}`,
    delDialogTitle: (title) => `删除知识条目「${title}」？`,
    delDialogDesc: '删除后助手将无法再检索到这条内容。此操作不可撤销。',
    cancel: '取消',
    titleContentRequired: '标题和内容都要填',
    delFailed: '删除失败，请重试',
    editEntry: '编辑条目',
    addEntry: '添加条目',
    cancelEdit: '取消编辑',
    titlePlaceholder: '标题，例如：语音日报项目',
    tagsPlaceholder: '标签（空格分隔，可选）',
    contentPlaceholder: '内容：这个项目/名词是什么，助手需要知道的背景',
    saveChanges: '保存修改',
    add: '添加',
  },
  en: {
    loading: 'Loading…',
    loadFailed: 'Failed to load, please refresh and retry',
    pageTitle: 'Brain',
    pageIntro: 'This is the voice assistant\'s global "brain": the team background and probing guidance are injected into the assistant on every call (all tasks); the knowledge base is available for the assistant to search on demand during conversations. Task-level briefs / question frameworks are maintained inside each task, scoped to that task only, and layered on top of the global content here. Changes take effect immediately, applying to the next call that starts.',
    teamBgTitle: 'Team background',
    teamBgHint: 'What the team is working on and its current focus. Helps the assistant understand what teammates are talking about; never read aloud.',
    teamBgPlaceholder: 'e.g. We are the OpenMax team, building an AI agent collaboration platform. Our current focus is…',
    probingTitle: 'Probing guidance',
    probingHint: 'Controls when the assistant probes, what it asks about, and how deep it goes. Whatever you care about, write it here.',
    probingPlaceholder: 'e.g. When someone says something is "mostly done", ask whether it has been verified…',
    saved: 'Saved, takes effect on the next call',
    saveFailed: 'Save failed, please retry',
    save: 'Save',
    kbTitle: 'Knowledge base',
    kbHint: 'Entries for projects, terms, team memory, etc.; the assistant searches here during conversations when it decides it needs to',
    kbEmpty: 'No knowledge entries yet — add the first one below',
    edit: 'Edit',
    editAria: (title) => `Edit ${title}`,
    del: 'Delete',
    delAria: (title) => `Delete ${title}`,
    delDialogTitle: (title) => `Delete knowledge entry "${title}"?`,
    delDialogDesc: 'Once deleted, the assistant can no longer retrieve this entry. This cannot be undone.',
    cancel: 'Cancel',
    titleContentRequired: 'Both title and content are required',
    delFailed: 'Delete failed, please retry',
    editEntry: 'Edit entry',
    addEntry: 'Add entry',
    cancelEdit: 'Cancel editing',
    titlePlaceholder: 'Title, e.g. Voice standup project',
    tagsPlaceholder: 'Tags (space-separated, optional)',
    contentPlaceholder: 'Content: what this project/term is, and the background the assistant needs to know',
    saveChanges: 'Save changes',
    add: 'Add',
  },
};

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

export default function BrainPage() {
  const T = useLangDict(DICT);
  const [ctx, setCtx] = useState(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setCtx(await api('api/context'));
    } catch (err) {
      if (err.status !== 401) setLoadError(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (ctx === null) {
    return <p className="text-sm text-muted-foreground">{loadError ? T.loadFailed : T.loading}</p>;
  }

  return (
    <>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">{T.pageTitle}</h1>
      <p className="mt-3 max-w-[680px] text-base text-muted-foreground">
        {T.pageIntro}
      </p>

      {loadError ? <p className="mt-6 text-sm text-destructive">{T.loadFailed}</p> : null}

      <ContextCard
        icon={Brain}
        title={T.teamBgTitle}
        hint={T.teamBgHint}
        placeholder={T.teamBgPlaceholder}
        initial={ctx.team_background}
        onSave={(v) => api('api/context', { method: 'PUT', body: { team_background: v } })}
      />

      <ContextCard
        icon={MessageCircleQuestion}
        title={T.probingTitle}
        hint={T.probingHint}
        placeholder={T.probingPlaceholder}
        initial={ctx.probing_guidance}
        onSave={(v) => api('api/context', { method: 'PUT', body: { probing_guidance: v } })}
      />

      <KnowledgeSection />
    </>
  );
}

function ContextCard({ icon: Icon, title, hint, placeholder, initial, onSave }) {
  const T = useLangDict(DICT);
  const [value, setValue] = useState(initial || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const dirty = value !== (initial || '');

  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(value);
      setMsg({ ok: true, key: 'saved' });
    } catch (err) {
      if (err.status !== 401) setMsg({ ok: false, key: 'saveFailed' });
    } finally {
      setBusy(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), 4000);
    }
  };

  return (
    <Card className="mt-6">
      <CardContent className="px-6 py-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="text-lg font-semibold leading-tight">{title}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>
          </div>
        </div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={6}
          className={cn(TEXTAREA_CLASS, 'mt-4')}
        />
        <div className="mt-3 flex items-center gap-3">
          <Button className="h-10 px-6 text-[0.95rem]" disabled={busy || !dirty} onClick={save}>
            {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : null}
            {T.save}
          </Button>
          {msg ? <span className={cn('text-sm', msg.ok ? 'text-success' : 'text-destructive')}>{T[msg.key]}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

const EMPTY_DRAFT = { id: null, title: '', tags: '', content: '' };

function KnowledgeSection() {
  const T = useLangDict(DICT);
  const [items, setItems] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const formRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await api('api/knowledge');
      setItems(data.knowledge || []);
    } catch (e) {
      if (e.status !== 401) setErr('loadFailed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const editing = draft.id !== null;

  const startEdit = (k) => {
    setDraft({ id: k.id, title: k.title, tags: k.tags || '', content: k.content });
    setErr('');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const reset = () => { setDraft(EMPTY_DRAFT); setErr(''); };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) { setErr('titleContentRequired'); return; }
    setBusy(true);
    setErr('');
    try {
      const body = { title, content, tags: draft.tags.trim() };
      if (editing) await api(`api/knowledge/${draft.id}`, { method: 'PUT', body });
      else await api('api/knowledge', { method: 'POST', body });
      reset();
      await load();
    } catch (e2) {
      if (e2.status !== 401) setErr('saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k) => {
    try {
      await api(`api/knowledge/${k.id}`, { method: 'DELETE' });
      if (draft.id === k.id) reset();
      await load();
    } catch (e) {
      if (e.status !== 401) setErr('delFailed');
    }
  };

  return (
    <Card className="mt-6">
      <CardContent className="px-6 py-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <BookOpen className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div>
            <h2 className="text-lg font-semibold leading-tight">{T.kbTitle}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {T.kbHint}
            </p>
          </div>
        </div>

        {/* entries */}
        <div className="mt-5 space-y-3">
          {items === null ? (
            <p className="text-sm text-muted-foreground">{T.loading}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-faint">{T.kbEmpty}</p>
          ) : (
            items.map((k) => (
              <div key={k.id} className="rounded-lg border border-border px-4 py-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[0.95rem] font-semibold">{k.title}</span>
                      {(k.tags || '').split(/\s+/).filter(Boolean).map((t) => (
                        <Badge key={t} className="font-normal">{t}</Badge>
                      ))}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-[0.9rem] leading-relaxed text-muted-foreground line-clamp-3">
                      {k.content}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" title={T.edit} aria-label={T.editAria(k.title)} onClick={() => startEdit(k)}>
                      <Pencil strokeWidth={1.75} />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" title={T.del} aria-label={T.delAria(k.title)} className="hover:bg-destructive-soft hover:text-destructive">
                          <Trash2 strokeWidth={1.75} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{T.delDialogTitle(k.title)}</AlertDialogTitle>
                          <AlertDialogDescription>{T.delDialogDesc}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{T.cancel}</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => remove(k)}>{T.del}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* add / edit form */}
        <form ref={formRef} onSubmit={submit} className="mt-5 rounded-lg border border-dashed border-border-strong px-4 py-4">
          <div className="flex items-center justify-between">
            <p className="text-[0.9rem] font-semibold text-muted-foreground">
              {editing ? T.editEntry : T.addEntry}
            </p>
            {editing ? (
              <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={reset}>
                <X className="h-3.5 w-3.5" strokeWidth={1.75} /> {T.cancelEdit}
              </Button>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder={T.titlePlaceholder}
              className="h-10 min-w-[240px] flex-1 text-[0.95rem]"
            />
            <Input
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              placeholder={T.tagsPlaceholder}
              className="h-10 min-w-[180px] flex-1 text-[0.95rem]"
            />
          </div>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder={T.contentPlaceholder}
            rows={4}
            className={cn(TEXTAREA_CLASS, 'mt-3')}
          />
          {err ? <p className="mt-2 text-sm text-destructive">{T[err]}</p> : null}
          <div className="mt-3">
            <Button type="submit" className="h-10 px-6 text-[0.95rem]" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" strokeWidth={1.75} /> : editing ? null : <Plus strokeWidth={1.75} />}
              {editing ? T.saveChanges : T.add}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { NotebookPen, Users2, Lock, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import { useLangDict } from '../i18n';

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2.5 text-[0.95rem] leading-relaxed text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring placeholder:text-faint resize-y';

const DICT = {
  zh: {
    title: '补充与跟进',
    sub: '会后补充或更新的信息——下一期会自动带给 AI，已拍板的会在汇总里收口，不再重复追问。这里默认只看本期新增；台账跨期保留。',
    empty: '本期还没有新增补充。开完会把拍板结论或新信息填在下面，AI 下次就知道了。',
    emptyAll: '还没有补充。开完会把拍板结论或新信息填在下面，AI 下次就知道了。',
    placeholder: '补充或更新一条与这个任务相关的信息……例如：「汇总模板」采用方案B，Howard 拍板。',
    share: '设为团队共享',
    shareHint: '共享给其它内部任务；不勾选则只在本任务可见',
    submit: '提交',
    submitting: '提交中…',
    team: '团队共享',
    priv: '仅本任务',
    del: '删除',
    confirm: '确认删除？',
    cancel: '取消',
    error: '提交失败，请重试',
    showAll: total => `查看全部台账（${total}）`,
    showCycle: '只看本期新增',
  },
  en: {
    title: 'Follow-ups',
    sub: 'Info appended or updated after a round — carried into the next cycle for the AI; settled items are closed out in the digest, not re-probed. Shows this cycle’s additions by default; the ledger persists across cycles.',
    empty: 'Nothing added this cycle. After a meeting, note the decision or new info below and the AI will know next time.',
    emptyAll: 'No follow-ups yet. After a meeting, note the decision or new info below and the AI will know next time.',
    placeholder: 'Append or update one piece of info about this task… e.g. "digest template": going with Option B, decided by Howard.',
    share: 'Share with team',
    shareHint: 'Visible to other internal tasks; unchecked stays private to this task',
    submit: 'Submit',
    submitting: 'Submitting…',
    team: 'Team-shared',
    priv: 'This task only',
    del: 'Delete',
    confirm: 'Delete this?',
    cancel: 'Cancel',
    error: 'Submit failed, please retry',
    showAll: total => `Show full ledger (${total})`,
    showCycle: 'This cycle only',
  },
};

/**
 * Follow-up panel for a task's detail page. Shows the follow-ups appended
 * during the viewed cycle (display is per-period; the underlying ledger is
 * cross-cycle and reachable via the "full ledger" toggle) and lets the owner
 * append a new one on the current cycle (private by default, or team-shared).
 * A follow-up is plain text — the general carry-forward container the daily
 * decision write-back dissolved into.
 */
export default function FollowupPanel({ taskId, cycle = null, canCompose = true }) {
  const T = useLangDict(DICT);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [content, setContent] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmId, setConfirmId] = useState(null);

  const windowed = Boolean(cycle) && !showAll;

  const load = useCallback(async () => {
    try {
      const q = windowed ? `&cycle=${encodeURIComponent(cycle)}` : '';
      const r = await api(`api/followups?task_id=${taskId}${q}`);
      setItems(r.followups || []);
      setTotal(r.total ?? (r.followups || []).length);
    } catch {
      /* leave list as-is on transient error */
    }
  }, [taskId, cycle, windowed]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr('');
    try {
      await api('api/followups', { method: 'POST', body: { task_id: taskId, content: text, scope: shared ? 'team' : 'private' } });
      setContent('');
      setShared(false);
      await load();
    } catch {
      setErr(T.error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try {
      await api(`api/followups/${id}`, { method: 'DELETE' });
      setConfirmId(null);
      await load();
    } catch {
      /* ignore */
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">
          <NotebookPen className="h-5 w-5 text-primary" strokeWidth={1.75} />
          {T.title}
          <span className="rounded-full border border-primary-line bg-primary-soft px-2.5 py-0.5 text-sm font-semibold text-primary">
            {items.length}
          </span>
          {cycle && total > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              className="ml-auto text-sm font-normal text-muted-foreground hover:text-foreground hover:underline"
            >
              {showAll ? T.showCycle : T.showAll(total)}
            </button>
          ) : null}
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">{T.sub}</p>
      </CardHeader>
      <CardContent className="space-y-4 pt-1">
        {/* list */}
        {items.length ? (
          <ul className="space-y-2.5">
            {items.map((f) => (
              <li key={f.id} className="rounded-md border border-border bg-accent/40 px-3.5 py-2.5">
                <div className="flex items-start gap-2">
                  <span
                    className={
                      f.scope === 'team'
                        ? 'inline-flex shrink-0 items-center gap-1 rounded-full border border-primary-line bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary'
                        : 'inline-flex shrink-0 items-center gap-1 rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-muted-foreground'
                    }
                  >
                    {f.scope === 'team' ? <Users2 className="h-3 w-3" strokeWidth={2} /> : <Lock className="h-3 w-3" strokeWidth={2} />}
                    {f.scope === 'team' ? T.team : T.priv}
                  </span>
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[0.95rem] leading-relaxed">{f.content}</p>
                  {confirmId === f.id ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs">
                      <button type="button" onClick={() => remove(f.id)} className="font-semibold text-destructive hover:underline">{T.confirm}</button>
                      <button type="button" onClick={() => setConfirmId(null)} className="text-muted-foreground hover:underline">{T.cancel}</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(f.id)}
                      className="shrink-0 text-faint transition-colors hover:text-destructive"
                      title={T.del}
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                {f.created_at ? (
                  <div className="mt-1 pl-1 text-xs text-faint">{String(f.created_at).slice(0, 16)}</div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3.5 py-4 text-center text-sm text-muted-foreground">
            {windowed ? T.empty : T.emptyAll}
          </p>
        )}

        {/* compose — current cycle only; past-cycle pages are read-only views */}
        {canCompose ? (
          <div className="space-y-2.5 border-t border-border pt-4">
            <textarea
              className={TEXTAREA_CLASS}
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={T.placeholder}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => setShared(e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                {T.share}
                <span className="text-xs text-faint">· {T.shareHint}</span>
              </label>
              <div className="ml-auto flex items-center gap-3">
                {err ? <span className="text-sm text-destructive">{err}</span> : null}
                <Button onClick={submit} disabled={busy || !content.trim()}>
                  {busy ? T.submitting : T.submit}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

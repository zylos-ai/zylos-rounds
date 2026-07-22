import { useState } from 'react';
import { Users, Sparkles, ListChecks, MessagesSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLangDict } from '../i18n';

const DICT = {
  zh: {
    missingTitle: '未汇报',
    allDone: '全员已完成',
    nobodyYet: '这一期还没有人完成对话',
    listSeparator: '、',
    minutes: (n) => `${n} 分钟`,
    keyPoints: '沟通要点',
    keySignals: '重点信号',
    transcript: '原始对话',
    emptyItems: '（无）',
    expandAll: '展开全部',
    collapseAll: '收起全部',
  },
  en: {
    missingTitle: 'Not reported',
    allDone: 'Everyone has completed',
    nobodyYet: 'No one has completed a conversation this cycle',
    listSeparator: ', ',
    minutes: (n) => `${n} min`,
    keyPoints: 'Key points',
    keySignals: 'Highlights',
    transcript: 'Transcript',
    emptyItems: '(none)',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
  },
};

/**
 * Cycle results for a generic (non-builtin) task — the counterpart of the
 * built-in daily's DayReportView: a "not reported" roster card plus one
 * collapsed card per member with results (expand for summary / highlights /
 * transcript). Link management lives in the separate MemberLinksCard —
 * management actions and content no longer share a row.
 */
export default function CycleResultsView({ members = [] }) {
  const T = useLangDict(DICT);
  // "Done" is submitted-only — the same criterion as the API's
  // submitted_count, the link-card badges and the built-in daily's day view
  // (store.dayReports filters status='submitted'). A draft transcript from a
  // dropped mid-call session must NOT clear a member off the missing roster.
  const done = members.filter((m) => m.status === 'submitted');
  const missing = members.filter((m) => m.status !== 'submitted').map((m) => m.name);

  const [openIds, setOpenIds] = useState(() => new Set());
  const toggle = (id) => setOpenIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const allOpen = done.length > 0 && openIds.size === done.length;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            <Users className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
            {T.missingTitle}
            <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-sm font-semibold text-muted-foreground">
              {missing.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <p className="text-[0.95rem]">{missing.length ? missing.join(T.listSeparator) : T.allDone}</p>
        </CardContent>
      </Card>

      {done.length > 0 ? (
        <>
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => setOpenIds(allOpen ? new Set() : new Set(done.map((m) => m.member_id)))}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {allOpen ? T.collapseAll : T.expandAll}
            </button>
          </div>
          <div className="grid grid-cols-2 items-start gap-4 max-md:grid-cols-1">
            {done.map((m) => (
              <MemberCycleCard key={m.member_id} m={m} open={openIds.has(m.member_id)} onToggle={() => toggle(m.member_id)} />
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3.5 py-4 text-center text-sm text-muted-foreground">
          {T.nobodyYet}
        </p>
      )}
    </>
  );
}

// One member's cycle result. Collapsed: name + duration. Expanded: summary
// points / highlights, transcript on demand.
function MemberCycleCard({ m, open, onToggle }) {
  const T = useLangDict(DICT);
  return (
    <Card>
      <CardContent className="py-4">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2 text-left"
          aria-expanded={open}
        >
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} strokeWidth={2} />
          <span className="text-lg font-semibold">{m.name}</span>
          {m.duration_s ? (
            <span className="ml-auto text-sm font-normal text-faint">{T.minutes(Math.round(m.duration_s / 60))}</span>
          ) : null}
        </button>
        {open && (
          <div className="mt-2">
            <ResultSection icon={ListChecks} title={T.keyPoints} items={m.summary} />
            {(m.highlights || []).length > 0 && <ResultSection icon={Sparkles} title={T.keySignals} items={m.highlights} />}
            <TranscriptToggle transcript={m.transcript} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TranscriptToggle({ transcript }) {
  const T = useLangDict(DICT);
  const [open, setOpen] = useState(false);
  if (!transcript || !transcript.trim()) return null;
  return (
    <div className="mt-4 border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[0.8rem] font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        <MessagesSquare className="h-4 w-4" strokeWidth={1.75} />
        {T.transcript}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} strokeWidth={2} />
      </button>
      {open ? (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-accent px-3 py-2.5 font-sans text-[0.85rem] leading-relaxed text-muted-foreground">
          {transcript}
        </pre>
      ) : null}
    </div>
  );
}

function ResultSection({ icon: Icon, title, items }) {
  const T = useLangDict(DICT);
  return (
    <div>
      <h3 className="mb-1.5 mt-4 flex items-center gap-1.5 text-[0.8rem] font-semibold text-muted-foreground">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
        {title}
      </h3>
      <ul className="list-disc pl-5 text-[0.95rem] leading-relaxed">
        {items && items.length ? items.map((x, i) => <li key={i}>{x}</li>) : <li className="text-faint">{T.emptyItems}</li>}
      </ul>
    </div>
  );
}

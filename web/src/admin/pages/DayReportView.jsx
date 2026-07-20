import { useState } from 'react';
import { MessageCircle, History, Target, TriangleAlert, Users, MessagesSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLangDict } from '../i18n';

const DICT = {
  zh: {
    topicsTitle: '建议日会重点讨论',
    noTopics: '这一天没有待议题',
    topicsSub: '多方拉通、方案取舍、需要拍板——一对一解决不了的事',
    minutes: (n) => `${n} 分钟`,
    yesterday: '昨天',
    today: '今天',
    blockers: '卡点 · 前置依赖',
    blockerBadge: (n) => `${n} 卡点`,
    missingTitle: '未汇报',
    allDone: '全员已完成',
    listSeparator: '、',
    transcript: '原始对话',
    emptyItems: '（无）',
    expandAll: '展开全部',
    collapseAll: '收起全部',
  },
  en: {
    topicsTitle: 'Suggested topics for today’s meeting',
    noTopics: 'No topics raised for this day',
    topicsSub: 'Multi-party alignment, trade-offs, decisions — things a one-on-one can\u2019t resolve',
    minutes: (n) => `${n} min`,
    yesterday: 'Yesterday',
    today: 'Today',
    blockers: 'Blockers · waiting on',
    blockerBadge: (n) => `${n} blocker${n > 1 ? 's' : ''}`,
    missingTitle: 'Not reported',
    allDone: 'Everyone has reported',
    listSeparator: ', ',
    transcript: 'Transcript',
    emptyItems: '(none)',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
  },
};

/**
 * Presentational day view of the built-in daily standup (topics highlight,
 * per-member four-bucket cards, missing roster). Rendered inside the daily
 * task's detail page — the successor of the old 今日报告/历史 pages.
 */
export default function DayReportView({ data, digestSlot = null }) {
  const T = useLangDict(DICT);
  const reports = data.reports || [];
  const missing = data.missing || [];
  const topics = data.topics || [];

  // Per-member cards collapse to a single line by default so a large roster
  // stays scannable and the digest above it is reachable without scrolling.
  const [openIdx, setOpenIdx] = useState(() => new Set());
  const toggle = (i) => setOpenIdx((prev) => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });
  const allOpen = reports.length > 0 && openIdx.size === reports.length;

  return (
    <>
      {/* meeting focus highlight */}
      <Card className="border-primary-line bg-gradient-to-b from-primary-soft to-card">
        <CardHeader>
          <CardTitle className="text-lg">
            <MessageCircle className="h-5 w-5 text-primary" strokeWidth={1.75} />
            {T.topicsTitle}
            <span className="rounded-full border border-primary-line bg-primary-soft px-2.5 py-0.5 text-sm font-semibold text-primary">
              {topics.length}
            </span>
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{T.topicsSub}</p>
        </CardHeader>
        <CardContent className="pt-2">
          <ul className="list-disc pl-5 text-[0.95rem] leading-relaxed">
            {topics.length ? (
              topics.map((x, i) => (
                <li key={i} className="my-1">
                  <b className="mr-2 font-semibold text-primary">{x.name}</b>
                  {x.topic}
                </li>
              ))
            ) : (
              <li className="text-faint">{T.noTopics}</li>
            )}
          </ul>
        </CardContent>
      </Card>

      {/* cycle digest — the aggregate view, kept above per-member detail */}
      {digestSlot}

      {/* missing */}
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

      {/* per-member detail — collapsed one-liners, expand on demand */}
      {reports.length > 0 && (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setOpenIdx(allOpen ? new Set() : new Set(reports.map((_, i) => i)))}
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {allOpen ? T.collapseAll : T.expandAll}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 items-start gap-4 max-md:grid-cols-1">
        {reports.map((r, i) => (
          <MemberReportCard key={i} r={r} open={openIdx.has(i)} onToggle={() => toggle(i)} />
        ))}
      </div>
    </>
  );
}

// One member's daily report. Collapsed: name + blocker badge + duration.
// Expanded: yesterday / today, blockers only when present, transcript on demand.
function MemberReportCard({ r, open, onToggle }) {
  const T = useLangDict(DICT);
  const blockers = r.blockers || [];
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
          <span className="text-lg font-semibold">{r.member_name}</span>
          {blockers.length > 0 && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
              {T.blockerBadge(blockers.length)}
            </span>
          )}
          {r.duration_s ? (
            <span className="ml-auto text-sm font-normal text-faint">{T.minutes(Math.round(r.duration_s / 60))}</span>
          ) : null}
        </button>
        {open && (
          <div className="mt-2">
            <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
              <ReportSection icon={History} title={T.yesterday} items={r.yesterday} />
              <ReportSection icon={Target} title={T.today} items={r.today} />
            </div>
            {blockers.length > 0 && <ReportSection icon={TriangleAlert} title={T.blockers} items={blockers} />}
            <TranscriptToggle transcript={r.transcript} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Raw conversation transcript — stored for review (备查), revealed on demand.
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

function ReportSection({ icon: Icon, title, items }) {
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

import { useState } from 'react';
import { MessageCircle, History, Target, TriangleAlert, Users, MessagesSquare, ChevronDown } from 'lucide-react';
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
    missingTitle: '未汇报',
    allDone: '全员已完成',
    listSeparator: '、',
    transcript: '原始对话',
    emptyItems: '（无）',
  },
  en: {
    topicsTitle: 'Suggested topics for today’s meeting',
    noTopics: 'No topics raised for this day',
    topicsSub: 'Multi-party alignment, trade-offs, decisions — things a one-on-one can\u2019t resolve',
    minutes: (n) => `${n} min`,
    yesterday: 'Yesterday',
    today: 'Today',
    blockers: 'Blockers · waiting on',
    missingTitle: 'Not reported',
    allDone: 'Everyone has reported',
    listSeparator: ', ',
    transcript: 'Transcript',
    emptyItems: '(none)',
  },
};

/**
 * Presentational day view of the built-in daily standup (topics highlight,
 * per-member four-bucket cards, missing roster). Rendered inside the daily
 * task's detail page — the successor of the old 今日报告/历史 pages.
 */
export default function DayReportView({ data }) {
  const T = useLangDict(DICT);
  const reports = data.reports || [];
  const missing = data.missing || [];
  const topics = data.topics || [];

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

      {/* per-member cards */}
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        {reports.map((r, i) => (
          <Card key={i}>
            <CardHeader>
              <CardTitle className="text-lg">
                {r.member_name}
                {r.duration_s ? (
                  <span className="ml-auto text-sm font-normal text-faint">{T.minutes(Math.round(r.duration_s / 60))}</span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-1">
              <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
                <ReportSection icon={History} title={T.yesterday} items={r.yesterday} />
                <ReportSection icon={Target} title={T.today} items={r.today} />
              </div>
              <ReportSection icon={TriangleAlert} title={T.blockers} items={r.blockers} />
              <TranscriptToggle transcript={r.transcript} />
            </CardContent>
          </Card>
        ))}
      </div>

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
    </>
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

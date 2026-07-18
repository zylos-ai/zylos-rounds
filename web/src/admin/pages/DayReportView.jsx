import { useState } from 'react';
import { MessageCircle, History, Target, TriangleAlert, Users, MessagesSquare, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Presentational day view of the built-in daily standup (topics highlight,
 * per-member four-bucket cards, missing roster). Rendered inside the daily
 * task's detail page — the successor of the old 今日报告/历史 pages.
 */
export default function DayReportView({ data }) {
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
            建议日会重点讨论
            <span className="rounded-full border border-primary-line bg-primary-soft px-2.5 py-0.5 text-sm font-semibold text-primary">
              {topics.length}
            </span>
          </CardTitle>
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
              <li className="text-faint">这一天没有待议题</li>
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
                  <span className="ml-auto text-sm font-normal text-faint">{Math.round(r.duration_s / 60)} 分钟</span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-1">
              <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
                <ReportSection icon={History} title="昨天" items={r.yesterday} />
                <ReportSection icon={Target} title="今天" items={r.today} />
              </div>
              <ReportSection icon={TriangleAlert} title="卡点" items={r.blockers} />
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
            未汇报
            <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-sm font-semibold text-muted-foreground">
              {missing.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <p className="text-[0.95rem]">{missing.length ? missing.join('、') : '全员已完成'}</p>
        </CardContent>
      </Card>
    </>
  );
}

// Raw conversation transcript — stored for review (备查), revealed on demand.
function TranscriptToggle({ transcript }) {
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
        原始对话
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
  return (
    <div>
      <h3 className="mb-1.5 mt-4 flex items-center gap-1.5 text-[0.8rem] font-semibold text-muted-foreground">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
        {title}
      </h3>
      <ul className="list-disc pl-5 text-[0.95rem] leading-relaxed">
        {items && items.length ? items.map((x, i) => <li key={i}>{x}</li>) : <li className="text-faint">（无）</li>}
      </ul>
    </div>
  );
}

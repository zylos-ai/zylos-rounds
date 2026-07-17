import { useEffect, useState } from 'react';
import { MessageCircle, History, Target, TriangleAlert, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '../api';

export default function ReportPage({ date }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api(`api/reports/${date}`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled && err.status !== 401) setError('加载失败，请刷新重试');
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">加载中…</p>;

  const reports = data.reports || [];
  const missing = data.missing || [];
  const topics = data.topics || [];
  const total = reports.length + missing.length;

  return (
    <>
      <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold">日报汇总 · {data.date || date}</h1>
      <p className="mb-5 text-sm text-muted-foreground">
        已汇报 {reports.length}/{total} 人 · 由语音对话自动生成
      </p>

      {/* meeting focus highlight */}
      <Card className="mb-3.5 border-primary-line bg-gradient-to-b from-primary-soft to-card">
        <CardHeader>
          <CardTitle>
            <MessageCircle className="h-4 w-4 text-primary" strokeWidth={1.75} />
            建议日会重点讨论
            <span className="rounded-full border border-primary-line bg-primary-soft px-2 py-px text-xs font-semibold text-primary">
              {topics.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <ul className="list-disc pl-5 text-[0.89rem] leading-relaxed">
            {topics.length ? (
              topics.map((x, i) => (
                <li key={i} className="my-0.5">
                  <b className="mr-2 font-semibold text-primary">{x.name}</b>
                  {x.topic}
                </li>
              ))
            ) : (
              <li className="text-faint">今天没有待议题</li>
            )}
          </ul>
        </CardContent>
      </Card>

      {/* per-member cards */}
      {reports.map((r, i) => (
        <Card key={i} className="mb-3.5">
          <CardHeader>
            <CardTitle>
              {r.member_name}
              {r.duration_s ? (
                <span className="ml-auto text-xs font-normal text-faint">{Math.round(r.duration_s / 60)} 分钟</span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-1">
            <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
              <ReportSection icon={History} title="昨天" items={r.yesterday} />
              <ReportSection icon={Target} title="今天" items={r.today} />
            </div>
            <ReportSection icon={TriangleAlert} title="卡点" items={r.blockers} />
          </CardContent>
        </Card>
      ))}

      {/* missing */}
      <Card>
        <CardHeader>
          <CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
            未汇报
            <span className="rounded-full border border-border-strong px-2 py-px text-xs font-semibold text-muted-foreground">
              {missing.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <p className="text-[0.9rem]">{missing.length ? missing.join('、') : '全员已完成'}</p>
        </CardContent>
      </Card>
    </>
  );
}

function ReportSection({ icon: Icon, title, items }) {
  return (
    <div>
      <h3 className="mb-1 mt-3 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        {title}
      </h3>
      <ul className="list-disc pl-5 text-[0.89rem] leading-relaxed">
        {items && items.length ? items.map((x, i) => <li key={i}>{x}</li>) : <li className="text-faint">（无）</li>}
      </ul>
    </div>
  );
}

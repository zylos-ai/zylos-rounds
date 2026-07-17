import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '../api';

export default function HistoryPage() {
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api('api/reports/history')
      .then((d) => {
        if (!cancelled) setDays(d.days || []);
      })
      .catch((err) => {
        if (!cancelled && err.status !== 401) setError('加载失败，请刷新重试');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (days === null) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <>
      <p className="mb-2 text-sm font-medium text-muted-foreground">每天有人汇报即自动生成当日报告，点日期查看</p>
      <h1 className="text-4xl font-bold tracking-tight max-sm:text-3xl">历史报告</h1>

      <Card className="mt-8">
        <CardContent className="px-4 py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[0.85rem]">日期</TableHead>
                <TableHead className="text-[0.85rem]">已汇报</TableHead>
                <TableHead className="text-[0.85rem]">日会待议</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-faint">
                    还没有任何日报
                  </TableCell>
                </TableRow>
              ) : (
                days.map((d) => (
                  <TableRow key={d.date}>
                    <TableCell className="py-4">
                      <a
                        href={`#/report/${d.date}`}
                        className="text-[0.95rem] font-semibold text-primary no-underline hover:underline"
                      >
                        {d.date}
                      </a>
                    </TableCell>
                    <TableCell className="py-4 text-[0.95rem] tabular-nums">
                      {d.submitted}/{d.member_count} 人
                    </TableCell>
                    <TableCell className="py-4">
                      {d.topics_count ? <Badge>{d.topics_count} 个待议题</Badge> : <span className="text-faint">—</span>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

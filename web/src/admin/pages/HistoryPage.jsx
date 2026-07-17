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
      <h1 className="mb-1 flex items-center gap-2 text-xl font-semibold">历史报告</h1>
      <p className="mb-5 text-sm text-muted-foreground">每天有人汇报即自动生成当日报告，点日期查看</p>

      <Card>
        <CardContent className="px-2 py-1.5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>已汇报</TableHead>
                <TableHead>日会待议</TableHead>
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
                    <TableCell>
                      <a href={`#/report/${d.date}`} className="font-medium text-primary no-underline hover:underline">
                        {d.date}
                      </a>
                    </TableCell>
                    <TableCell>
                      {d.submitted}/{d.member_count} 人
                    </TableCell>
                    <TableCell>
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

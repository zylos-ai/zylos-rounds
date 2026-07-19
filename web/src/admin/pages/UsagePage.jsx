import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleDollarSign, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '../api';
import { useLangDict } from '../i18n';

const DICT = {
  zh: {
    slotLabels: { voice: '语音', profile: '画像', digest: '汇总' },
    minutes: (n) => `${n} 分钟`,
    underOneMinute: '<1 分钟',
    title: '用量与成本',
    subtitle: '按 API 返回的真实 token 用量与官方价目估算（美元）',
    prevMonth: '上一月',
    nextMonth: '下一月',
    loading: '加载中…',
    loadFailed: '用量数据加载失败，请刷新重试',
    monthTotal: '本月累计',
    today: '今日',
    byModel: '按模型',
    colModel: '模型',
    colSlot: '用途',
    colCalls: '次数',
    colDuration: '时长',
    colCost: '费用',
    noUsage: '本月还没有用量记录（从 v0.11.0 上线后的通话开始统计）',
    byMember: '按成员',
    colMember: '成员',
    footnote: '成本按内置价目表估算，与账单可能有细微出入；官方调价后可在后台更新价目，无需升级。统计自 v0.11.0 上线起。',
  },
  en: {
    slotLabels: { voice: 'Voice', profile: 'Profile', digest: 'Digest' },
    minutes: (n) => `${n} min`,
    underOneMinute: '<1 min',
    title: 'Usage & Cost',
    subtitle: 'Estimated from real API-reported token usage at official list prices (USD)',
    prevMonth: 'Previous month',
    nextMonth: 'Next month',
    loading: 'Loading…',
    loadFailed: 'Failed to load usage data, please refresh and try again',
    monthTotal: 'Month to date',
    today: 'Today',
    byModel: 'By model',
    colModel: 'Model',
    colSlot: 'Purpose',
    colCalls: 'Calls',
    colDuration: 'Duration',
    colCost: 'Cost',
    noUsage: 'No usage recorded this month yet (tracking starts with calls after the v0.11.0 release)',
    byMember: 'By member',
    colMember: 'Member',
    footnote: 'Costs are estimated from the built-in price table and may differ slightly from your bill; prices can be updated in the backend after official changes, no upgrade needed. Tracking starts from the v0.11.0 release.',
  },
};

const fmtUsd = (v) => `$${(v || 0) < 0.995 ? (v || 0).toFixed(3) : (v || 0).toFixed(2)}`;
const fmtMinutes = (s, T) => {
  const min = (s || 0) / 60;
  return min >= 1 ? T.minutes(min.toFixed(0)) : s > 0 ? T.underOneMinute : '—';
};

/**
 * 用量与成本 — real API-reported token usage priced from the built-in table.
 * Promoted out of the settings page in v0.11.1 (viewing, not configuring).
 * Mobile: stat tiles stack naturally; tables keep few columns, truncate the
 * long model ids, and fall back to horizontal scroll inside their own box.
 */
export default function UsagePage() {
  const T = useLangDict(DICT);
  const [usage, setUsage] = useState(null);
  const [month, setMonth] = useState(''); // '' = current month
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let stale = false;
    setBusy(true);
    api(`api/usage${month ? `?month=${month}` : ''}`)
      .then((data) => { if (!stale) { setUsage(data); setError(false); } })
      .catch((err) => { if (!stale && err.status !== 401) setError(true); })
      .finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; };
  }, [month]);

  const shiftMonth = (delta) => {
    const cur = month || usage?.month;
    if (!cur) return;
    const [y, m] = cur.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <CircleDollarSign className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight">{T.title}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{T.subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shiftMonth(-1)} aria-label={T.prevMonth}>
            <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          </Button>
          <span className="min-w-[4.5rem] text-center font-medium tabular-nums">{usage?.month || '—'}</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => shiftMonth(1)} aria-label={T.nextMonth}>
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </div>
      </div>

      {busy && !usage ? (
        <p className="mt-8 text-sm text-muted-foreground"><Loader2 className="mr-1.5 inline h-4 w-4 animate-spin" strokeWidth={1.75} />{T.loading}</p>
      ) : error || !usage ? (
        <p className="mt-8 text-sm text-muted-foreground">{T.loadFailed}</p>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:max-w-md max-sm:gap-3">
            <Card>
              <CardContent className="px-5 py-4 max-sm:px-4">
                <p className="text-sm text-muted-foreground">{T.monthTotal}</p>
                <p className="mt-1 text-3xl font-bold tabular-nums max-sm:text-2xl">{fmtUsd(usage.total_usd)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="px-5 py-4 max-sm:px-4">
                <p className="text-sm text-muted-foreground">{T.today}</p>
                <p className="mt-1 text-3xl font-bold tabular-nums max-sm:text-2xl">{fmtUsd(usage.today_usd)}</p>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-6">
            <CardContent className="px-6 py-5 max-sm:px-4">
              <h2 className="text-base font-semibold">{T.byModel}</h2>
              {usage.by_model.length ? (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">{T.colModel}</th>
                        <th className="py-1.5 pr-3 font-medium max-sm:hidden">{T.colSlot}</th>
                        <th className="whitespace-nowrap py-1.5 pr-3 text-right font-medium">{T.colCalls}</th>
                        <th className="whitespace-nowrap py-1.5 pr-3 text-right font-medium">{T.colDuration}</th>
                        <th className="whitespace-nowrap py-1.5 text-right font-medium">{T.colCost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_model.map((r) => (
                        <tr key={`${r.model}-${r.slot}`} className="border-b border-border/60 last:border-0">
                          <td className="py-2 pr-3" title={r.model}>
                            <span className="flex items-baseline gap-1.5">
                              <span className="max-w-[38vw] truncate font-mono text-[0.8rem] sm:max-w-none">{r.model}</span>
                              <span className="shrink-0 text-xs text-muted-foreground sm:hidden">{T.slotLabels[r.slot] || r.slot}</span>
                            </span>
                          </td>
                          <td className="py-2 pr-3 max-sm:hidden">{T.slotLabels[r.slot] || r.slot}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.calls}</td>
                          <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{r.slot === 'voice' ? fmtMinutes(r.seconds, T) : '—'}</td>
                          <td className="py-2 text-right tabular-nums">{fmtUsd(r.usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">{T.noUsage}</p>
              )}
            </CardContent>
          </Card>

          {usage.by_member.length ? (
            <Card className="mt-5">
              <CardContent className="px-6 py-5 max-sm:px-4">
                <h2 className="text-base font-semibold">{T.byMember}</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1.5 pr-3 font-medium">{T.colMember}</th>
                        <th className="py-1.5 pr-3 text-right font-medium">{T.colCalls}</th>
                        <th className="py-1.5 pr-3 text-right font-medium">{T.colDuration}</th>
                        <th className="py-1.5 text-right font-medium">{T.colCost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.by_member.map((r) => (
                        <tr key={r.member_id} className="border-b border-border/60 last:border-0">
                          <td className="py-2 pr-3">{r.name || `#${r.member_id}`}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{r.calls}</td>
                          <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">{fmtMinutes(r.seconds, T)}</td>
                          <td className="py-2 text-right tabular-nums">{fmtUsd(r.usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <p className="mt-5 text-xs text-muted-foreground">
            {T.footnote}
          </p>
        </>
      )}
    </>
  );
}

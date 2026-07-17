import { useCallback, useEffect, useState } from 'react';
import { Mic, Users, FileText, History, LogOut } from 'lucide-react';
import { cn, today } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { api } from './api';
import { useRoute, navigate } from './router';
import LoginPage from './pages/LoginPage';
import RosterPage from './pages/RosterPage';
import ReportPage from './pages/ReportPage';
import HistoryPage from './pages/HistoryPage';

export default function App() {
  const route = useRoute();
  const [authed, setAuthed] = useState(null); // null = checking
  const [reportDate, setReportDate] = useState('');

  useEffect(() => {
    api('api/auth/me')
      .then((r) => {
        const ok = !!(r && r.authenticated);
        setAuthed(ok);
        if (r?.date) setReportDate(r.date);
        if (!ok) navigate('#/login');
      })
      .catch(() => {
        setAuthed(false);
        navigate('#/login');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onLoggedIn = useCallback(async () => {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await api('api/auth/me');
        if (r?.authenticated && r?.date) {
          setReportDate(r.date);
          setAuthed(true);
          navigate('#/');
          return;
        }
      } catch { /* retry once */ }
    }
    throw new Error('date_fetch_failed');
  }, []);

  const onLogout = useCallback(async () => {
    try {
      await api('api/auth/logout', { method: 'POST' });
    } catch {
      /* session may already be gone */
    }
    setAuthed(false);
    navigate('#/login');
  }, []);

  if (route.name === 'login') return <LoginPage onLoggedIn={onLoggedIn} />;

  if (authed === null) {
    return <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">加载中…</div>;
  }
  if (!authed) return null; // redirecting to #/login

  return (
    <Layout route={route} onLogout={onLogout} reportDate={reportDate}>
      {route.name === 'roster' && <RosterPage />}
      {route.name === 'report' && <ReportPage date={route.date} />}
      {route.name === 'history' && <HistoryPage />}
    </Layout>
  );
}

function Layout({ route, onLogout, reportDate, children }) {
  const t = reportDate || today();
  const nav = [
    { label: '管理', hash: '#/', icon: Users, active: route.name === 'roster' },
    { label: '今日报告', hash: `#/report/${t}`, icon: FileText, active: route.name === 'report' && route.date === t },
    {
      label: '历史',
      hash: '#/reports',
      icon: History,
      active: route.name === 'history' || (route.name === 'report' && route.date !== t),
    },
  ];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-[52px] max-w-[760px] items-center gap-4 px-5">
          <a href="#/" className="flex items-center gap-2 text-[0.95rem] font-semibold text-foreground no-underline">
            <Mic className="h-[18px] w-[18px] text-primary" strokeWidth={1.75} />
            语音日报
          </a>
          <nav className="flex items-center gap-1">
            {nav.map((item) => (
              <a
                key={item.hash}
                href={item.hash}
                className={cn(
                  'inline-flex h-[30px] items-center gap-1.5 rounded-md px-3 text-sm font-medium no-underline transition-colors duration-150',
                  item.active
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <item.icon className="h-3.5 w-3.5 max-sm:hidden" strokeWidth={1.75} />
                {item.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto">
            <Button variant="ghost" size="icon" title="退出登录" aria-label="退出登录" onClick={onLogout}>
              <LogOut strokeWidth={1.75} />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[760px] px-5 pb-12 pt-6">{children}</main>
    </div>
  );
}

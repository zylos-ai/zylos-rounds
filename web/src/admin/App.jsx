import { useCallback, useEffect, useState } from 'react';
import { Mic, Users, FileText, History, LogOut, Settings as SettingsIcon } from 'lucide-react';
import { cn, today } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { api } from './api';
import { useRoute, navigate } from './router';
import LoginPage from './pages/LoginPage';
import RosterPage from './pages/RosterPage';
import ReportPage from './pages/ReportPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  const route = useRoute();
  const [authed, setAuthed] = useState(null); // null = checking
  const [reportDate, setReportDate] = useState('');

  useEffect(() => {
    api('api/auth/me')
      .then((r) => {
        if (r?.authenticated && r?.date) {
          setReportDate(r.date);
          setAuthed(true);
        } else {
          setAuthed(false);
          navigate('#/login');
        }
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
      {route.name === 'settings' && <SettingsPage />}
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
    { label: '设置', hash: '#/settings', icon: SettingsIcon, active: route.name === 'settings' },
  ];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-6 max-sm:gap-3 max-sm:px-4">
          <a href="#/" className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-foreground no-underline">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mic className="h-[18px] w-[18px]" strokeWidth={2} />
            </span>
            <span className="max-sm:hidden">语音日报</span>
          </a>
          <nav className="flex items-center gap-1.5">
            {nav.map((item) => (
              <a
                key={item.hash}
                href={item.hash}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[0.9rem] font-medium no-underline transition-colors duration-150 max-sm:px-3',
                  item.active
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4 max-sm:hidden" strokeWidth={1.75} />
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
      <main className="mx-auto max-w-[1200px] px-6 pb-16 pt-10 max-sm:px-4 max-sm:pt-6">{children}</main>
    </div>
  );
}

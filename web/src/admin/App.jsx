import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Users, LogOut, Brain, Settings as SettingsIcon, ClipboardList, CircleDollarSign, Languages } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { api } from './api';
import { useRoute, navigate } from './router';
import { useI18n, useLangDict } from './i18n';

const APP_DICT = {
  zh: {
    loading: '加载中…',
    redirecting: '跳转中…',
    navTasks: '任务',
    navMembers: '成员',
    navBrain: '大脑',
    navUsage: '用量',
    navSettings: '设置',
    logout: '退出登录',
    switchLang: 'Switch to English',
  },
  en: {
    loading: 'Loading…',
    redirecting: 'Redirecting…',
    navTasks: 'Tasks',
    navMembers: 'Members',
    navBrain: 'Brain',
    navUsage: 'Usage',
    navSettings: 'Settings',
    logout: 'Log out',
    switchLang: '切换到中文',
  },
};
import LoginPage from './pages/LoginPage';
import MembersPage from './pages/MembersPage';
import BrainPage from './pages/BrainPage';
import SettingsPage from './pages/SettingsPage';
import UsagePage from './pages/UsagePage';
import { TasksPage, TaskDetailPage } from './pages/TasksPage';

export default function App() {
  const route = useRoute();
  const T = useLangDict(APP_DICT);
  const [authed, setAuthed] = useState(null); // null = checking

  useEffect(() => {
    api('api/auth/me')
      .then((r) => {
        if (r?.authenticated) {
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
        if (r?.authenticated) {
          setAuthed(true);
          navigate('#/');
          return;
        }
      } catch { /* retry once */ }
    }
    throw new Error('auth_check_failed');
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
    return <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">{T.loading}</div>;
  }
  if (!authed) return null; // redirecting to #/login

  return (
    <Layout route={route} onLogout={onLogout}>
      {route.name === 'tasks' && <TasksPage />}
      {route.name === 'task' && <TaskDetailPage id={route.id} cycle={route.cycle} />}
      {route.name === 'members' && <MembersPage />}
      {route.name === 'brain' && <BrainPage />}
      {route.name === 'usage' && <UsagePage />}
      {route.name === 'settings' && <SettingsPage />}
      {route.name === 'legacyReport' && <LegacyDailyRedirect date={route.date} />}
    </Layout>
  );
}

// The old 今日报告/历史 hashes land inside the built-in daily task's detail.
function LegacyDailyRedirect({ date }) {
  useEffect(() => {
    let cancelled = false;
    api('api/tasks')
      .then((r) => {
        if (cancelled) return;
        const daily = (r.tasks || []).find((t) => t.is_builtin);
        if (daily) navigate(`#/tasks/${daily.id}${date ? `/c/${date}` : ''}`);
        else navigate('#/');
      })
      .catch(() => { if (!cancelled) navigate('#/'); });
    return () => { cancelled = true; };
  }, [date]);
  return <RedirectingNote />;
}

function RedirectingNote() {
  const T = useLangDict(APP_DICT);
  return <p className="text-sm text-muted-foreground">{T.redirecting}</p>;
}

function Layout({ route, onLogout, children }) {
  const navRef = useRef(null);
  const T = useLangDict(APP_DICT);
  const { lang, setLang } = useI18n();

  // desktop only — on narrow screens the tabs live in the bottom bar instead
  useEffect(() => {
    const el = navRef.current?.querySelector('[data-active="true"]');
    if (el && navRef.current.scrollWidth > navRef.current.clientWidth) {
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, [route.name]);
  const nav = [
    { label: T.navTasks, hash: '#/', icon: ClipboardList, active: route.name === 'tasks' || route.name === 'task' || route.name === 'legacyReport' },
    { label: T.navMembers, hash: '#/members', icon: Users, active: route.name === 'members' },
    { label: T.navBrain, hash: '#/brain', icon: Brain, active: route.name === 'brain' },
    { label: T.navUsage, hash: '#/usage', icon: CircleDollarSign, active: route.name === 'usage' },
    { label: T.navSettings, hash: '#/settings', icon: SettingsIcon, active: route.name === 'settings' },
  ];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-6 max-sm:gap-3 max-sm:px-4">
          <a href="#/" className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-foreground no-underline">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mic className="h-[18px] w-[18px]" strokeWidth={2} />
            </span>
            Rounds
          </a>
          <nav ref={navRef} className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:hidden sm:flex-none">
            {nav.map((item) => (
              <a
                key={item.hash}
                href={item.hash}
                data-active={item.active || undefined}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 text-[0.9rem] font-medium no-underline transition-colors duration-150',
                  item.active
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4" strokeWidth={1.75} />
                {item.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              title={T.switchLang}
              aria-label={T.switchLang}
              className="gap-1.5 text-muted-foreground"
              onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            >
              <Languages className="h-4 w-4" strokeWidth={1.75} />
              {lang === 'zh' ? 'EN' : '中'}
            </Button>
            <Button variant="ghost" size="icon" title={T.logout} aria-label={T.logout} onClick={onLogout}>
              <LogOut strokeWidth={1.75} />
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-6 pb-16 pt-10 max-sm:px-4 max-sm:pb-28 max-sm:pt-6">{children}</main>
      {/* mobile: fixed bottom tab bar (5 entries = standard capacity); desktop keeps the top nav */}
      <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] sm:hidden">
        <div className="grid grid-cols-5">
          {nav.map((item) => (
            <a
              key={item.hash}
              href={item.hash}
              className={cn(
                'flex flex-col items-center gap-1 py-2 text-[0.7rem] font-medium no-underline transition-colors duration-150',
                item.active ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <item.icon className="h-5 w-5" strokeWidth={item.active ? 2 : 1.75} />
              {item.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  );
}

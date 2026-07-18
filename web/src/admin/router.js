import { useEffect, useState } from 'react';

/**
 * Hash router (no server rewrites). v0.7 modules: 任务(home) / 成员 / 大脑 / 设置.
 *   #/                     tasks home
 *   #/tasks/:id            task detail (current cycle)
 *   #/tasks/:id/c/:cycle   task detail at a specific cycle (date or '-')
 *   #/members #/brain #/settings #/login
 * Legacy hashes (#/reports, #/report/:date) redirect into the built-in
 * daily task's detail — the old pages were absorbed there.
 */
export function parseHash() {
  const h = (location.hash || '').replace(/^#/, '') || '/';
  if (h === '/login') return { name: 'login' };
  if (h === '/' || h === '/tasks') return { name: 'tasks' };
  let m = h.match(/^\/tasks\/(\d+)$/);
  if (m) return { name: 'task', id: Number(m[1]), cycle: null };
  m = h.match(/^\/tasks\/(\d+)\/c\/(\d{4}-\d{2}-\d{2}|-)$/);
  if (m) return { name: 'task', id: Number(m[1]), cycle: m[2] };
  if (h === '/members') return { name: 'members' };
  if (h === '/brain') return { name: 'brain' };
  if (h === '/settings') return { name: 'settings' };
  if (h === '/reports') return { name: 'legacyReport', date: null };
  m = h.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
  if (m) return { name: 'legacyReport', date: m[1] };
  return { name: 'tasks' };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(hash) {
  location.hash = hash;
}

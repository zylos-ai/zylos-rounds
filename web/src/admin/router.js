import { useEffect, useState } from 'react';

/** Hash router: #/, #/report/:date, #/reports, #/login. No server rewrites. */
export function parseHash() {
  const h = (location.hash || '').replace(/^#/, '') || '/';
  if (h === '/login') return { name: 'login' };
  if (h === '/reports') return { name: 'history' };
  if (h === '/brain') return { name: 'brain' };
  if (h === '/tasks') return { name: 'tasks' };
  const tm = h.match(/^\/tasks\/(\d+)$/);
  if (tm) return { name: 'task', id: Number(tm[1]) };
  if (h === '/settings') return { name: 'settings' };
  const m = h.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
  if (m) return { name: 'report', date: m[1] };
  return { name: 'roster' };
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

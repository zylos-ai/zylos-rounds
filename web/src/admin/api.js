/**
 * Minimal API client. All URLs are RELATIVE to the document (the SPA is
 * served at the component root behind an arbitrary reverse-proxy prefix,
 * e.g. /standup/), so never start a path with '/'.
 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('api/auth/')) {
    location.hash = '#/login';
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    let msg = '';
    try {
      msg = (await res.json()).error || '';
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

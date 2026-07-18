/**
 * Minimal API client. All URLs are RELATIVE to the document (the SPA is
 * served at the component root behind an arbitrary reverse-proxy prefix,
 * e.g. /standup/), so never start a path with '/'.
 */
export class ApiError extends Error {
  constructor(status, message, data = null) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.data = data; // parsed error body (e.g. { error, slots }) when JSON
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
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, data?.error || '', data);
  }
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

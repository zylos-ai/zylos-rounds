/**
 * Small HTTP helpers shared by auth/api/static layers.
 */

export function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function sendText(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

export function sendHtml(res, code, body, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}

const MAX_BODY_BYTES = 16384;

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // Accumulate raw bytes and decode once — per-chunk toString() corrupts
    // multi-byte UTF-8 characters that straddle chunk boundaries.
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request_too_large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      const body = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

export function getClientIp(req) {
  const remoteIp = req.socket.remoteAddress || '';
  // Only trust X-Forwarded-For from the local reverse proxy (Caddy).
  if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
  }
  return remoteIp;
}

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  }
  return cookies;
}

/**
 * Absolute URL prefix for browser-facing links (member talk links),
 * honoring the reverse proxy's X-Forwarded-* headers.
 */
export function browserOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const prefix = req.headers['x-forwarded-prefix'] || '';
  return `${proto}://${host}${prefix.replace(/\/$/, '')}`;
}

export function todayLocal(timeZone = 'Asia/Shanghai') {
  return new Date().toLocaleDateString('sv-SE', { timeZone });
}

/**
 * Static serving of the built frontend (src/public/).
 * Hashed assets get immutable caching; HTML entries are no-store.
 */

import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export class Static {
  constructor(publicDir) {
    this.publicDir = publicDir;
  }

  /** Serve a file relative to publicDir. Returns true if served. */
  serve(res, relPath, { cacheImmutable = false } = {}) {
    const abs = path.resolve(this.publicDir, relPath.replace(/^\/+/, ''));
    if (!abs.startsWith(path.resolve(this.publicDir) + path.sep) &&
        abs !== path.resolve(this.publicDir)) {
      return false; // path traversal
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheImmutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
    return true;
  }
}

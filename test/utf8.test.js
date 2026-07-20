import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { callChatModel } from '../src/lib/llm.js';
import { readJsonBody } from '../src/lib/http-util.js';

// Regression: multi-byte UTF-8 characters split across chunk boundaries must
// survive decoding intact (previously each chunk was stringified separately,
// turning e.g. "链" into two U+FFFD replacement characters).

test('callChatModel decodes a response split mid-character', async () => {
  const payload = Buffer.from(JSON.stringify({
    choices: [{ message: { content: '对商业化与用户账户链路较敏感' } }],
  }));
  // Split inside "链" (3-byte char): find its first byte and cut one byte in.
  const cut = payload.indexOf(Buffer.from('链')) + 1;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(payload.subarray(0, cut));
    setTimeout(() => res.end(payload.subarray(cut)), 30);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const text = await callChatModel({
      base: `http://127.0.0.1:${server.address().port}`,
      model: 'model-x', key: 'k', prompt: 'p',
    });
    assert.equal(text, '对商业化与用户账户链路较敏感');
  } finally {
    server.close();
  }
});

test('callChatModel retries transient failures up to `attempts`, but not 4xx', async () => {
  // A server that resets the connection on the first N requests, then succeeds.
  let hits = 0;
  let failFirst = 2;
  const server = createServer((req, res) => {
    hits++;
    if (hits <= failFirst) { req.destroy(); return; } // transient socket error
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 3 attempts: two failures then success → recovers.
    const text = await callChatModel({ base, model: 'm', key: 'k', prompt: 'p', attempts: 3 });
    assert.equal(text, 'ok');
    assert.equal(hits, 3);

    // Default (attempts:1) does not retry → first transient error surfaces.
    hits = 0; failFirst = 1;
    await assert.rejects(() => callChatModel({ base, model: 'm', key: 'k', prompt: 'p' }));
    assert.equal(hits, 1);

    // 4xx is not retryable even with attempts>1 → fails fast after one call.
    hits = 0; failFirst = 0;
    const s4xx = createServer((req, res) => { hits++; res.writeHead(401); res.end('nope'); });
    await new Promise(r => s4xx.listen(0, '127.0.0.1', r));
    const base4 = `http://127.0.0.1:${s4xx.address().port}`;
    let c = 0;
    s4xx.on('request', () => { c++; });
    await assert.rejects(() => callChatModel({ base: base4, model: 'm', key: 'k', prompt: 'p', attempts: 3 }), /http_401/);
    assert.equal(c, 1); // no retry on 401
    s4xx.close();
  } finally {
    server.close();
  }
});

test('readJsonBody decodes a body split mid-character', async () => {
  const body = Buffer.from(JSON.stringify({ context: '产品研发方向链路' }));
  const cut = body.indexOf(Buffer.from('链')) + 1;
  const req = new EventEmitter();
  const promise = readJsonBody(req);
  req.emit('data', body.subarray(0, cut));
  req.emit('data', body.subarray(cut));
  req.emit('end');
  assert.deepEqual(await promise, { context: '产品研发方向链路' });
});

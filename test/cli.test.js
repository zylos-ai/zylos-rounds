import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, resolveTarget } from '../scripts/cli.js';

test('parseArgs separates flags (anywhere) from positionals', () => {
  const { flags, rest } = parseArgs(['knowledge', 'add', '--title', '发布系统', '--tags', 'release', '正文']);
  assert.deepEqual(rest, ['knowledge', 'add', '正文']);
  assert.equal(flags.title, '发布系统');
  assert.equal(flags.tags, 'release');
});

test('resolveTarget precedence: flags > env > cli.json > config.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-cli-'));
  const dataDir = path.join(home, 'zylos/components/rounds');
  fs.mkdirSync(dataDir, { recursive: true });

  assert.equal(resolveTarget({}, {}, home), null); // nothing configured

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 4000, serviceToken: 'cfg-key' }));
  assert.deepEqual(resolveTarget({}, {}, home), { url: 'http://127.0.0.1:4000', key: 'cfg-key' });

  fs.writeFileSync(path.join(dataDir, 'cli.json'), JSON.stringify({ url: 'https://host/standup', apiKey: 'cli-key' }));
  assert.deepEqual(resolveTarget({}, {}, home), { url: 'https://host/standup', key: 'cli-key' });

  const env = { ROUNDS_URL: 'https://env/standup', ROUNDS_API_KEY: 'env-key' };
  assert.deepEqual(resolveTarget({}, env, home), { url: 'https://env/standup', key: 'env-key' });

  assert.deepEqual(
    resolveTarget({ url: 'https://flag/standup', key: 'flag-key' }, env, home),
    { url: 'https://flag/standup', key: 'flag-key' },
  );
});

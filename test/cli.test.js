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

test('resolveTarget precedence: flags > env > cli.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-cli-'));
  const dataDir = path.join(home, 'zylos/components/rounds');
  fs.mkdirSync(dataDir, { recursive: true });

  assert.equal(resolveTarget({}, {}, home), null); // nothing configured

  // v0.18: config.json is not a credential source anymore
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 4000, serviceToken: 'cfg-key' }));
  assert.equal(resolveTarget({}, {}, home), null);

  fs.writeFileSync(path.join(dataDir, 'cli.json'), JSON.stringify({ url: 'https://host/standup', apiKey: 'cli-key' }));
  assert.deepEqual(resolveTarget({}, {}, home), { url: 'https://host/standup', key: 'cli-key' });

  const env = { ROUNDS_URL: 'https://env/standup', ROUNDS_API_KEY: 'env-key' };
  assert.deepEqual(resolveTarget({}, env, home), { url: 'https://env/standup', key: 'env-key' });

  assert.deepEqual(
    resolveTarget({ url: 'https://flag/standup', key: 'flag-key' }, env, home),
    { url: 'https://flag/standup', key: 'flag-key' },
  );
});

test('resolveTarget searches ROUNDS_HOME and ~/.rounds before the zylos data dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standup-cli-'));
  const zylosDir = path.join(home, 'zylos/components/rounds');
  const dotDir = path.join(home, '.rounds');
  const customDir = path.join(home, 'custom-data');
  fs.mkdirSync(zylosDir, { recursive: true });
  fs.mkdirSync(dotDir, { recursive: true });
  fs.mkdirSync(customDir, { recursive: true });

  // zylos dir alone still resolves (backward compat)
  fs.writeFileSync(path.join(zylosDir, 'cli.json'), JSON.stringify({ url: 'https://zylos/rounds', apiKey: 'z-key' }));
  assert.deepEqual(resolveTarget({}, {}, home), { url: 'https://zylos/rounds', key: 'z-key' });

  // ~/.rounds wins over the zylos dir
  fs.writeFileSync(path.join(dotDir, 'cli.json'), JSON.stringify({ url: 'https://dot/rounds', apiKey: 'd-key' }));
  assert.deepEqual(resolveTarget({}, {}, home), { url: 'https://dot/rounds', key: 'd-key' });

  // $ROUNDS_HOME wins over both
  fs.writeFileSync(path.join(customDir, 'cli.json'), JSON.stringify({ url: 'https://custom/rounds', apiKey: 'c-key' }));
  assert.deepEqual(resolveTarget({}, { ROUNDS_HOME: customDir }, home), { url: 'https://custom/rounds', key: 'c-key' });

  // config.json in any dir never resolves (v0.18: cli.json only)
  fs.rmSync(path.join(customDir, 'cli.json'));
  fs.rmSync(path.join(dotDir, 'cli.json'));
  fs.rmSync(path.join(zylosDir, 'cli.json'));
  fs.writeFileSync(path.join(customDir, 'config.json'), JSON.stringify({ port: 5000, serviceToken: 'local-key' }));
  assert.equal(resolveTarget({}, { ROUNDS_HOME: customDir }, home), null);
});

test('CLIENT_VERSION matches package.json version', async () => {
  const { CLIENT_VERSION } = await import('../scripts/cli.js');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CLIENT_VERSION, pkg.version);
});

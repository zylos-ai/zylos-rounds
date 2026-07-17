#!/usr/bin/env node
/**
 * Post-install hook for zylos-standup
 *
 * Called by zylos after configure hook and CLI installation.
 * - Creates data subdirectories
 * - Generates the admin password on first install (printed ONCE below,
 *   only the scrypt hash is stored in config.json)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../src/lib/auth.js';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/standup');

console.log('[post-install] Running standup-specific setup...\n');

console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
console.log('  - logs/');
console.log('  - data/');

const configPath = path.join(DATA_DIR, 'config.json');
let config;
try {
  config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : { enabled: true };
} catch {
  config = { enabled: true };
}

if (!config.auth?.password) {
  const password = crypto.randomBytes(24).toString('base64url');
  config.auth = { ...(config.auth || {}), enabled: true, password: hashPassword(password) };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('\nGenerated admin password (config had none).');
  console.log('=========================================================');
  console.log(`  Admin password: ${password}`);
  console.log('  (shown only once — store it now; only a hash is saved)');
  console.log('=========================================================');
} else {
  console.log('\nConfig already has a password, skipping generation.');
}

console.log('\n[post-install] Complete!');

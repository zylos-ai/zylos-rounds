#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-rounds
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/rounds');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running standup-specific migrations...\n');

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 2: Ensure auth password exists (fail-closed)
    if (!config.auth?.password) {
      const crypto = await import('node:crypto');
      const { hashPassword } = await import('../src/lib/auth.js');
      const password = crypto.randomBytes(24).toString('base64url');
      config.auth = { ...(config.auth || {}), enabled: true, password: hashPassword(password) };
      migrated = true;
      migrations.push('Generated missing admin password');
      console.log('=========================================================');
      console.log(`  Admin password: ${password}`);
      console.log('  (shown only once — store it now; only a hash is saved)');
      console.log('=========================================================');
    }

    // Save if migrated
    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

console.log('\n[post-upgrade] Complete!');

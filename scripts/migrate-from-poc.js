#!/usr/bin/env node
/**
 * One-time migration: import members + reports from the voice-standup-poc DB
 * into the standup component DB, preserving member ids and tokens (member
 * links must not change).
 *
 * Idempotent: rows that already exist (by unique token / member_id+date) are
 * skipped, never overwritten.
 *
 * Usage:
 *   node scripts/migrate-from-poc.js [--source <poc.db>] [--target <standup.db>] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.HOME;
const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const dryRun = args.includes('--dry-run');

const sourcePath = opt('source') || path.join(HOME, 'zylos/workspace/voice-standup-poc/voice-standup.db');
const targetPath = opt('target') || path.join(HOME, 'zylos/components/standup/data/standup.db');

if (!fs.existsSync(sourcePath)) {
  console.error(`source DB not found: ${sourcePath}`);
  process.exit(1);
}
if (!fs.existsSync(targetPath)) {
  console.error(`target DB not found: ${targetPath} — start the component once first (it creates the schema)`);
  process.exit(1);
}

const src = new DatabaseSync(sourcePath, { readOnly: true });
const dst = new DatabaseSync(targetPath);

const members = src.prepare('SELECT * FROM members ORDER BY id').all();
const reports = src.prepare('SELECT * FROM reports ORDER BY id').all();

let mAdded = 0;
let mSkipped = 0;
let rAdded = 0;
let rSkipped = 0;

dst.exec('BEGIN');
try {
  for (const m of members) {
    const existing = dst.prepare('SELECT id, token FROM members WHERE id=?').get(m.id);
    if (existing) {
      if (existing.token !== m.token) {
        throw new Error(`member id ${m.id} exists with a DIFFERENT token — refusing to continue`);
      }
      mSkipped++;
      continue;
    }
    if (!dryRun) {
      dst.prepare('INSERT INTO members(id,name,token,active,created_at) VALUES(?,?,?,?,?)')
        .run(m.id, m.name, m.token, m.active, m.created_at);
    }
    mAdded++;
  }
  for (const r of reports) {
    const existing = dst.prepare('SELECT id FROM reports WHERE member_id=? AND report_date=?')
      .get(r.member_id, r.report_date);
    if (existing) {
      rSkipped++;
      continue;
    }
    if (!dryRun) {
      dst.prepare(`INSERT INTO reports(member_id,report_date,status,yesterday,today,blockers,topics,
          raw_json,transcript,duration_s,model,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.member_id, r.report_date, r.status, r.yesterday, r.today, r.blockers, r.topics,
          r.raw_json, r.transcript, r.duration_s, r.model, r.created_at, r.updated_at);
    }
    rAdded++;
  }
  dst.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
} catch (e) {
  dst.exec('ROLLBACK');
  console.error(`migration failed, rolled back: ${e.message}`);
  process.exit(1);
}

// keep AUTOINCREMENT counters ahead of imported ids
if (!dryRun) {
  // sqlite_sequence has no unique constraint — update-then-insert instead of upsert
  for (const [table, max] of [
    ['members', dst.prepare('SELECT MAX(id) v FROM members').get().v || 0],
    ['reports', dst.prepare('SELECT MAX(id) v FROM reports').get().v || 0],
  ]) {
    const info = dst.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?').run(max, table);
    if (!info.changes) dst.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(table, max);
  }
}

console.log(`${dryRun ? '[dry-run] ' : ''}members: ${mAdded} imported, ${mSkipped} already present`);
console.log(`${dryRun ? '[dry-run] ' : ''}reports: ${rAdded} imported, ${rSkipped} already present`);

const activeTokens = dst.prepare('SELECT COUNT(*) c FROM members WHERE active=1').get().c;
console.log(`${dryRun ? '[dry-run] ' : ''}active members in target: ${dryRun ? '(unchanged in dry-run) ' : ''}${activeTokens}`);

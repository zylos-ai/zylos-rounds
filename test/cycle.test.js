import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ONESHOT_CYCLE, isoDow, parseDowSet, currentCycleKey, nextCycleStart, previousCycleKey, cadenceLabel,
} from '../src/lib/cycle.js';

// Fixture weekdays verified with `date -d`: 2026-07-13 Mon, 2026-07-17 Fri,
// 2026-07-18 Sat, 2026-07-20 Mon, 2026-07-24 Fri.

test('isoDow: Mon=1 .. Sun=7', () => {
  assert.equal(isoDow('2026-07-13'), 1);
  assert.equal(isoDow('2026-07-17'), 5);
  assert.equal(isoDow('2026-07-18'), 6);
  assert.equal(isoDow('2026-07-19'), 7);
});

test('parseDowSet: dedupes, sorts, drops junk', () => {
  assert.deepEqual(parseDowSet('5,1,5, 3'), [1, 3, 5]);
  assert.deepEqual(parseDowSet('0,8,x,,'), []);
  assert.deepEqual(parseDowSet(null), []);
});

test('daily: cycle is the day itself; prev/next are adjacent days', () => {
  const t = { cadence_type: 'daily' };
  assert.equal(currentCycleKey(t, '2026-07-18'), '2026-07-18');
  assert.equal(nextCycleStart(t, '2026-07-18'), '2026-07-19');
  assert.equal(previousCycleKey(t, '2026-07-18'), '2026-07-17');
});

test('weekly: current cycle is the latest selected dow <= today', () => {
  const t = { cadence_type: 'weekly', cadence_dow: '1,5' }; // Mon + Fri
  assert.equal(currentCycleKey(t, '2026-07-18'), '2026-07-17'); // Sat -> last Fri
  assert.equal(currentCycleKey(t, '2026-07-17'), '2026-07-17'); // Fri -> itself
  assert.equal(currentCycleKey(t, '2026-07-16'), '2026-07-13'); // Thu -> last Mon
  assert.equal(nextCycleStart(t, '2026-07-17'), '2026-07-20');  // Fri cycle ends before Mon
  assert.equal(previousCycleKey(t, '2026-07-18'), '2026-07-13'); // cycle before current Fri = Mon
});

test('weekly: no valid dows -> null everywhere', () => {
  const t = { cadence_type: 'weekly', cadence_dow: '' };
  assert.equal(currentCycleKey(t, '2026-07-18'), null);
  assert.equal(nextCycleStart(t, '2026-07-18'), null);
  assert.equal(previousCycleKey(t, '2026-07-18'), null);
});

test('interval: anchored every-N-days windows', () => {
  const t = { cadence_type: 'interval', cadence_interval_days: 7, cadence_anchor: '2026-07-06' };
  assert.equal(currentCycleKey(t, '2026-07-06'), '2026-07-06'); // anchor day
  assert.equal(currentCycleKey(t, '2026-07-12'), '2026-07-06'); // inside first window
  assert.equal(currentCycleKey(t, '2026-07-13'), '2026-07-13'); // second window starts
  assert.equal(currentCycleKey(t, '2026-07-18'), '2026-07-13');
  assert.equal(nextCycleStart(t, '2026-07-13'), '2026-07-20');
  assert.equal(previousCycleKey(t, '2026-07-18'), '2026-07-06');
});

test('interval: future anchor means the first cycle has not started', () => {
  const t = { cadence_type: 'interval', cadence_interval_days: 7, cadence_anchor: '2026-08-01' };
  assert.equal(currentCycleKey(t, '2026-07-18'), null);
  // and there is no cycle before the anchor's first window
  const t2 = { cadence_type: 'interval', cadence_interval_days: 7, cadence_anchor: '2026-07-13' };
  assert.equal(previousCycleKey(t2, '2026-07-18'), null);
});

test('invalid cadence config returns null, oneshot constant is stable', () => {
  assert.equal(currentCycleKey({ cadence_type: 'interval', cadence_interval_days: 0, cadence_anchor: '2026-07-06' }, '2026-07-18'), null);
  assert.equal(currentCycleKey({ cadence_type: null }, '2026-07-18'), null);
  assert.equal(ONESHOT_CYCLE, '-');
});

test('cadenceLabel renders human chips', () => {
  assert.equal(cadenceLabel({ cadence_type: 'daily' }), '每天');
  assert.equal(cadenceLabel({ cadence_type: 'weekly', cadence_dow: '1,5' }), '每周 周一/周五');
  assert.equal(cadenceLabel({ cadence_type: 'interval', cadence_interval_days: 3 }), '每 3 天');
  assert.equal(cadenceLabel({ cadence_type: null }), '');
});

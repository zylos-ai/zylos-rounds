/**
 * Cycle math for recurring tasks. All inputs/outputs are local-date strings
 * (YYYY-MM-DD, computed by the caller in the configured timezone); arithmetic
 * runs on UTC timestamps of date-only strings so DST never bites.
 *
 * A cycle is identified by its start date (cycle_key). The current cycle for a
 * given "today" is the latest cycle start <= today; it ends the day before the
 * next cycle start. Conversations bind to the cycle current at the moment the
 * link is opened (lenient windows — no lockout, per the v0.7 plan).
 *
 * Cadences (owner ruling 2026-07-18): 'daily' | 'weekly' (ISO dow set, Mon=1)
 * | 'interval' (every N days from an anchor date). Oneshot tasks have no
 * cadence and use the fixed cycle_key '-'.
 */

export const ONESHOT_CYCLE = '-';

const DAY_MS = 86_400_000;

const toUtc = d => Date.parse(`${d}T00:00:00Z`);
const toDateStr = ms => new Date(ms).toISOString().slice(0, 10);

/** ISO day of week (Mon=1..Sun=7) of a YYYY-MM-DD string. */
export function isoDow(dateStr) {
  return ((new Date(toUtc(dateStr)).getUTCDay() + 6) % 7) + 1;
}

export function parseDowSet(cadenceDow) {
  return [...new Set(String(cadenceDow || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
}

/**
 * Current cycle start (cycle_key) for a recurring task on `today`.
 * Returns null when the task has no valid cadence, or when the first cycle
 * hasn't started yet (weekly task created before its first selected dow).
 */
export function currentCycleKey(task, today) {
  switch (task.cadence_type) {
    case 'daily':
      return today;
    case 'weekly': {
      const dows = parseDowSet(task.cadence_dow);
      if (!dows.length) return null;
      let ms = toUtc(today);
      for (let i = 0; i < 7; i++) {
        const d = toDateStr(ms);
        if (dows.includes(isoDow(d))) return d;
        ms -= DAY_MS;
      }
      return null;
    }
    case 'interval': {
      const n = Number(task.cadence_interval_days);
      const anchor = task.cadence_anchor;
      if (!Number.isInteger(n) || n < 1 || !anchor) return null;
      const diff = Math.floor((toUtc(today) - toUtc(anchor)) / DAY_MS);
      if (diff < 0) return null; // anchor in the future — first cycle not started
      return toDateStr(toUtc(anchor) + Math.floor(diff / n) * n * DAY_MS);
    }
    default:
      return null;
  }
}

/** Start date of the cycle after the one beginning at cycleKey (exclusive end). */
export function nextCycleStart(task, cycleKey) {
  switch (task.cadence_type) {
    case 'daily':
      return toDateStr(toUtc(cycleKey) + DAY_MS);
    case 'weekly': {
      const dows = parseDowSet(task.cadence_dow);
      if (!dows.length) return null;
      let ms = toUtc(cycleKey) + DAY_MS;
      for (let i = 0; i < 7; i++) {
        const d = toDateStr(ms);
        if (dows.includes(isoDow(d))) return d;
        ms += DAY_MS;
      }
      return null;
    }
    case 'interval': {
      const n = Number(task.cadence_interval_days);
      if (!Number.isInteger(n) || n < 1) return null;
      return toDateStr(toUtc(cycleKey) + n * DAY_MS);
    }
    default:
      return null;
  }
}

/**
 * The most recently *ended* cycle as of `today` (the one the auto digest
 * fires for), or null when the current cycle is still the first one.
 */
export function previousCycleKey(task, today) {
  const current = currentCycleKey(task, today);
  if (!current) return null;
  switch (task.cadence_type) {
    case 'daily':
      return toDateStr(toUtc(current) - DAY_MS);
    case 'weekly': {
      const dows = parseDowSet(task.cadence_dow);
      if (!dows.length) return null;
      let ms = toUtc(current) - DAY_MS;
      for (let i = 0; i < 7; i++) {
        const d = toDateStr(ms);
        if (dows.includes(isoDow(d))) return d;
        ms -= DAY_MS;
      }
      return null;
    }
    case 'interval': {
      const n = Number(task.cadence_interval_days);
      if (!Number.isInteger(n) || n < 1) return null;
      const prev = toUtc(current) - n * DAY_MS;
      if (task.cadence_anchor && prev < toUtc(task.cadence_anchor)) return null;
      return toDateStr(prev);
    }
    default:
      return null;
  }
}

/** Human label for a task's cadence, for list/detail chips. */
export function cadenceLabel(task) {
  const DOW_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  switch (task.cadence_type) {
    case 'daily':
      return '每天';
    case 'weekly': {
      const dows = parseDowSet(task.cadence_dow);
      return dows.length ? `每周 ${dows.map(d => DOW_CN[d]).join('/')}` : '每周';
    }
    case 'interval':
      return `每 ${task.cadence_interval_days} 天`;
    default:
      return '';
  }
}

/**
 * Browser-local history of pool readings, for the recorded half of the pool
 * chart and its burn rate.
 *
 * Stored in localStorage (not sessionStorage) because a burn rate needs hours
 * of readings, which outlive a tab. Series are bounded by appendPoolSample —
 * retention, a minimum spacing, and a hard cap — so this stays a few tens of
 * kilobytes. Readings are only taken when quota data is actually loaded; there
 * is no background polling.
 */

import { appendPoolSample, type PoolMode, type PoolSample } from './quotaPoolModel';

const POOL_HISTORY_KEY = 'quotaPage.poolHistory.v1';

type PoolHistory = Record<string, [number, number, number][]>;

export const poolSeriesKey = (provider: string, mode: PoolMode) => `${provider}:${mode}`;

const isTuple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((part) => typeof part === 'number' && Number.isFinite(part));

function readAll(): PoolHistory {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(POOL_HISTORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PoolHistory = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([key, series]) => {
      if (Array.isArray(series)) out[key] = series.filter(isTuple);
    });
    return out;
  } catch {
    return {};
  }
}

export function readPoolSeries(key: string): PoolSample[] {
  return (readAll()[key] ?? []).map(([t, v, c]) => ({ t, v, c }));
}

/** Record a reading and return the updated series. */
export function recordPoolSample(key: string, sample: PoolSample): PoolSample[] {
  const all = readAll();
  const current = (all[key] ?? []).map(([t, v, c]) => ({ t, v, c }));
  const next = appendPoolSample(current, {
    t: Math.round(sample.t),
    // Two decimals is far below anything the chart can show.
    v: Math.round(sample.v * 100) / 100,
    c: sample.c,
  });
  if (typeof window !== 'undefined') {
    try {
      all[key] = next.map((s) => [s.t, s.v, s.c]);
      window.localStorage.setItem(POOL_HISTORY_KEY, JSON.stringify(all));
    } catch {
      // Storage full or disabled: the chart still works without history.
    }
  }
  return next;
}

/**
 * Pooled quota: one provider's credentials summed into a single capacity.
 *
 * The cards say how much each credential has left and the timeline says when
 * each window resets. Neither answers the question a rotating pool actually
 * raises: *at the current pace, does the pool run dry before the next reset
 * tops it up?* That needs the sum, a burn rate, and a projection that adds
 * each credential back to full at its own reset instant.
 *
 * Pure functions only — `now` is always passed in — so every case here is
 * directly testable.
 */

import { HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { TimelineLane } from './quotaTimelineModel';

export type PoolMode = 'weekly' | 'session';

/** Hours of the window each mode pools. Session is the rolling 5-hour window. */
const SESSION_PERIOD_HOURS = 5;

/** One credential's contribution to the pool, normalized from a timeline lane. */
export interface PoolLane {
  name: string;
  displayName: string;
  /** Remaining percent, 0..100. */
  remaining: number;
  /** A known reset instant; every other reset derives from it. */
  anchorMs: number;
  periodMs: number;
}

/** A recorded pool reading. Kept compact because it is persisted. */
export interface PoolSample {
  /** Epoch ms. */
  t: number;
  /** Summed remaining percent. */
  v: number;
  /** Capacity at the time (100 × credentials), so readings across a pool change aren't compared. */
  c: number;
}

export interface PoolPoint {
  t: number;
  v: number;
}

export interface PoolResetEvent {
  t: number;
  name: string;
  displayName: string;
  /** Percentage points the reset adds back. */
  gain: number;
  /** Pool total just after the reset. */
  level: number;
}

export interface PoolProjection {
  capacity: number;
  remaining: number;
  points: PoolPoint[];
  resets: PoolResetEvent[];
  /** First instant the whole pool reaches zero, or null if not within the horizon. */
  poolEmptyMs: number | null;
  /** First credential to reach zero within the horizon. */
  firstEmpty: { name: string; displayName: string; t: number } | null;
  nextReset: PoolResetEvent | null;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/**
 * Keep only lanes that describe the mode's window.
 *
 * The lane builder falls back to the shortest window when nothing fits, so a
 * weekly request can hand back a 5-hour lane; mixing those into a weekly pool
 * would add capacity that refills twenty times faster than the rest.
 */
export function toPoolLanes(lanes: readonly TimelineLane[], mode: PoolMode): PoolLane[] {
  return lanes.flatMap((lane) => {
    if (lane.anchorMs === null || lane.remaining === null || !lane.periodHours) return [];
    const isSession = lane.periodHours <= SESSION_PERIOD_HOURS;
    if ((mode === 'session') !== isSession) return [];
    return [
      {
        name: lane.name,
        displayName: lane.displayName,
        remaining: clampPercent(lane.remaining),
        anchorMs: lane.anchorMs,
        periodMs: lane.periodHours * HOUR_MS,
      },
    ];
  });
}

/** Next reset strictly after `now`, aligned to the lane's anchor. */
export function nextResetAfter(lane: Pick<PoolLane, 'anchorMs' | 'periodMs'>, now: number) {
  if (lane.anchorMs > now) return lane.anchorMs;
  return lane.anchorMs + (Math.floor((now - lane.anchorMs) / lane.periodMs) + 1) * lane.periodMs;
}

/**
 * Average draw in percentage points per hour over the trailing window.
 *
 * Only drops count: a rise is a reset (or a credential being added back), not
 * negative usage, and treating it as such would make a pool that just reset
 * look like it is filling itself. Readings taken against a different capacity
 * are skipped for the same reason. Returns null until the samples cover enough
 * time to mean anything.
 */
export function burnRatePerHour(
  samples: readonly PoolSample[],
  now: number,
  windowHours: number,
  minSpanMs = 15 * MINUTE_MS
): number | null {
  const from = now - windowHours * HOUR_MS;
  const recent = samples.filter((s) => s.t >= from && s.t <= now).sort((a, b) => a.t - b.t);
  if (recent.length < 2) return null;

  const span = recent[recent.length - 1].t - recent[0].t;
  if (span < minSpanMs) return null;

  let drop = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const cur = recent[i];
    if (cur.c !== prev.c) continue;
    if (cur.v < prev.v) drop += prev.v - cur.v;
  }
  return drop / (span / HOUR_MS);
}

/**
 * Spread `amount` over the non-empty lanes, evenly, as round-robin routing
 * would. A lane that runs out hands its share to the others.
 */
function drain(levels: number[], amount: number): void {
  let left = amount;
  // Each pass either empties a lane or spends everything, so this ends within
  // levels.length passes.
  for (let pass = 0; pass < levels.length && left > 1e-9; pass += 1) {
    const active = levels.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    if (active.length === 0) return;
    const share = left / active.length;
    left = 0;
    active.forEach((i) => {
      const take = Math.min(levels[i], share);
      levels[i] -= take;
      left += share - take;
    });
  }
}

/**
 * Project the pool forward from `now` to `endMs`.
 *
 * Each credential resets to full at its own instants; between resets the burn
 * rate is drawn evenly from whatever still has quota. A null or zero burn rate
 * still yields a useful line — flat, with every upcoming reset marked.
 */
export function projectPool(
  lanes: readonly PoolLane[],
  now: number,
  endMs: number,
  burnPerHour: number | null,
  stepMs = 30 * MINUTE_MS
): PoolProjection {
  const capacity = lanes.length * 100;
  // A reported window whose reset already passed has refilled; the payload is
  // just older than the reset.
  const levels = lanes.map((lane) => (lane.anchorMs <= now ? 100 : lane.remaining));
  const nextResets = lanes.map((lane) => nextResetAfter(lane, now));
  const sum = () => levels.reduce((total, v) => total + v, 0);

  const remaining = sum();
  const points: PoolPoint[] = [{ t: now, v: remaining }];
  const resets: PoolResetEvent[] = [];
  let poolEmptyMs: number | null = remaining <= 0 && lanes.length > 0 ? now : null;
  let firstEmpty: PoolProjection['firstEmpty'] = null;
  const burn = burnPerHour !== null && burnPerHour > 0 ? burnPerHour : 0;

  if (lanes.length === 0 || !(endMs > now) || !(stepMs > 0)) {
    return { capacity, remaining, points, resets, poolEmptyMs, firstEmpty, nextReset: null };
  }

  // Bound the loop against a pathological horizon or step.
  const maxSteps = Math.min(5000, Math.ceil((endMs - now) / stepMs));
  let t = now;
  for (let step = 0; step < maxSteps; step += 1) {
    const stepEnd = Math.min(endMs, t + stepMs);

    // Resets inside this step, in order, each drawn as a vertical jump.
    for (;;) {
      let index = -1;
      nextResets.forEach((at, i) => {
        if (at <= stepEnd && (index < 0 || at < nextResets[index])) index = i;
      });
      if (index < 0) break;

      const at = nextResets[index];
      drain(levels, (burn * (at - t)) / HOUR_MS);
      t = at;
      const gain = 100 - levels[index];
      points.push({ t: at, v: sum() });
      levels[index] = 100;
      const level = sum();
      points.push({ t: at, v: level });
      resets.push({
        t: at,
        name: lanes[index].name,
        displayName: lanes[index].displayName,
        gain,
        level,
      });
      nextResets[index] += lanes[index].periodMs;
    }

    drain(levels, (burn * (stepEnd - t)) / HOUR_MS);
    t = stepEnd;
    const total = sum();
    points.push({ t, v: total });

    if (firstEmpty === null) {
      const emptied = levels.findIndex((v) => v <= 1e-6);
      if (emptied >= 0) {
        firstEmpty = { name: lanes[emptied].name, displayName: lanes[emptied].displayName, t };
      }
    }
    if (poolEmptyMs === null && total <= 1e-6) poolEmptyMs = t;
    if (t >= endMs) break;
  }

  return {
    capacity,
    remaining,
    points,
    resets,
    poolEmptyMs,
    firstEmpty,
    nextReset: resets[0] ?? null,
  };
}

/* ---------------------------------------------------------------- history */

/** Readings closer together than this replace the previous one instead of appending. */
export const POOL_SAMPLE_INTERVAL_MS = 10 * MINUTE_MS;
export const POOL_HISTORY_RETENTION_MS = 14 * 24 * HOUR_MS;
/** Hard cap per series: 14 days at one reading per 10 minutes, with headroom. */
export const POOL_HISTORY_MAX_SAMPLES = 2100;

/**
 * Append a reading, keeping the series small.
 *
 * The newest point stays live: a reading within the sample interval of the
 * point before it replaces it rather than appending, so refreshing every
 * minute neither grows storage nor stalls the series. A capacity change always
 * appends so the burn-rate calculation can see the boundary.
 */
export function appendPoolSample(
  series: readonly PoolSample[],
  sample: PoolSample
): PoolSample[] {
  const kept = series.filter(
    (s) => s.t > sample.t - POOL_HISTORY_RETENTION_MS && s.t <= sample.t
  );
  const last = kept[kept.length - 1];
  const prev = kept[kept.length - 2];
  const replaceLast =
    last !== undefined &&
    prev !== undefined &&
    last.c === sample.c &&
    prev.c === sample.c &&
    sample.t - prev.t < POOL_SAMPLE_INTERVAL_MS;
  if (replaceLast) kept[kept.length - 1] = sample;
  else kept.push(sample);
  return kept.length > POOL_HISTORY_MAX_SAMPLES
    ? kept.slice(kept.length - POOL_HISTORY_MAX_SAMPLES)
    : kept;
}

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { QuotaPool } from '../src/features/quota/components/QuotaPool';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import {
  POOL_HISTORY_MAX_SAMPLES,
  POOL_HISTORY_RETENTION_MS,
  POOL_SAMPLE_INTERVAL_MS,
  appendPoolSample,
  burnRatePerHour,
  nextResetAfter,
  projectPool,
  toPoolLanes,
  type PoolLane,
  type PoolSample,
} from '../src/features/quota/quotaPoolModel';
import type { TimelineLane } from '../src/features/quota/quotaTimelineModel';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../src/utils/time/durations';

const NOW = new Date(2026, 9, 27, 12).getTime();

const lane = (overrides: Partial<PoolLane> = {}): PoolLane => ({
  name: 'a.json',
  displayName: 'a',
  remaining: 50,
  anchorMs: NOW + DAY_MS,
  periodMs: 7 * DAY_MS,
  ...overrides,
});

const timelineLane = (overrides: Partial<TimelineLane> = {}): TimelineLane => ({
  name: 'a.json',
  displayName: 'a',
  provider: 'claude',
  anchorMs: NOW + DAY_MS,
  periodHours: 168,
  remaining: 40,
  limits: [],
  resetCredits: [],
  ...overrides,
});

describe('toPoolLanes', () => {
  test('keeps only lanes matching the pooled window', () => {
    const lanes = [
      timelineLane({ name: 'weekly.json' }),
      timelineLane({ name: 'session.json', periodHours: 5 }),
      timelineLane({ name: 'unloaded.json', anchorMs: null, remaining: null }),
    ];
    expect(toPoolLanes(lanes, 'weekly').map((l) => l.name)).toEqual(['weekly.json']);
    expect(toPoolLanes(lanes, 'session').map((l) => l.name)).toEqual(['session.json']);
  });
});

describe('nextResetAfter', () => {
  test('rolls a stale anchor forward by whole periods', () => {
    const period = 5 * HOUR_MS;
    const anchor = NOW - 2 * period - HOUR_MS;
    expect(nextResetAfter({ anchorMs: anchor, periodMs: period }, NOW)).toBe(anchor + 3 * period);
    expect(nextResetAfter({ anchorMs: NOW + 1, periodMs: period }, NOW)).toBe(NOW + 1);
  });
});

describe('burnRatePerHour', () => {
  test('counts drops and ignores rises from resets', () => {
    const samples: PoolSample[] = [
      { t: NOW - 3 * HOUR_MS, v: 300, c: 300 },
      { t: NOW - 2 * HOUR_MS, v: 290, c: 300 },
      // A reset: not negative usage.
      { t: NOW - HOUR_MS, v: 300, c: 300 },
      { t: NOW, v: 295, c: 300 },
    ];
    expect(burnRatePerHour(samples, NOW, 3)).toBeCloseTo(15 / 3);
  });

  test('skips steps across a capacity change', () => {
    const samples: PoolSample[] = [
      { t: NOW - 2 * HOUR_MS, v: 300, c: 300 },
      { t: NOW - HOUR_MS, v: 180, c: 200 },
      { t: NOW, v: 170, c: 200 },
    ];
    expect(burnRatePerHour(samples, NOW, 3)).toBeCloseTo(10 / 2);
  });

  test('is null until the samples cover enough time', () => {
    expect(burnRatePerHour([], NOW, 3)).toBeNull();
    expect(
      burnRatePerHour(
        [
          { t: NOW - 5 * MINUTE_MS, v: 100, c: 100 },
          { t: NOW, v: 99, c: 100 },
        ],
        NOW,
        3
      )
    ).toBeNull();
  });
});

describe('projectPool', () => {
  test('without a burn rate the pool only rises at resets', () => {
    const projection = projectPool(
      [lane({ remaining: 40, anchorMs: NOW + 2 * HOUR_MS })],
      NOW,
      NOW + 6 * HOUR_MS,
      null
    );
    expect(projection.remaining).toBe(40);
    expect(projection.nextReset).toMatchObject({ t: NOW + 2 * HOUR_MS, gain: 60, level: 100 });
    expect(projection.poolEmptyMs).toBeNull();
    expect(projection.points[projection.points.length - 1].v).toBe(100);
  });

  test('finds the first credential and the pool running dry', () => {
    const projection = projectPool(
      [
        lane({ name: 'low.json', displayName: 'low', remaining: 10, anchorMs: NOW + 9 * DAY_MS }),
        lane({ name: 'high.json', displayName: 'high', remaining: 30, anchorMs: NOW + 9 * DAY_MS }),
      ],
      NOW,
      NOW + 2 * DAY_MS,
      10
    );
    // 10 points/h shared by two lanes: "low" empties after 2h, then "high"
    // carries everything — 20 left after 2h at 10/h is 2 more hours.
    expect(projection.firstEmpty?.name).toBe('low.json');
    expect(projection.firstEmpty?.t).toBe(NOW + 2 * HOUR_MS);
    expect(projection.poolEmptyMs).toBe(NOW + 4 * HOUR_MS);
  });

  test('treats a window whose reset already passed as full', () => {
    const projection = projectPool(
      [lane({ remaining: 5, anchorMs: NOW - HOUR_MS })],
      NOW,
      NOW + HOUR_MS,
      null
    );
    expect(projection.remaining).toBe(100);
  });

  test('stays bounded on a pathological step', () => {
    const projection = projectPool([lane()], NOW, NOW + 365 * DAY_MS, 1, 1);
    expect(projection.points.length).toBeLessThanOrEqual(5000 * 3 + 1);
  });
});

describe('appendPoolSample', () => {
  test('replaces the live point inside the interval and appends after it', () => {
    let series: PoolSample[] = [];
    series = appendPoolSample(series, { t: NOW, v: 100, c: 100 });
    series = appendPoolSample(series, { t: NOW + MINUTE_MS, v: 99, c: 100 });
    series = appendPoolSample(series, { t: NOW + 2 * MINUTE_MS, v: 98, c: 100 });
    expect(series.map((s) => s.v)).toEqual([100, 98]);

    series = appendPoolSample(series, { t: NOW + POOL_SAMPLE_INTERVAL_MS + MINUTE_MS, v: 90, c: 100 });
    expect(series.map((s) => s.v)).toEqual([100, 98, 90]);
  });

  test('drops readings past retention and caps the series', () => {
    const old = { t: NOW - POOL_HISTORY_RETENTION_MS - 1, v: 1, c: 100 };
    expect(appendPoolSample([old], { t: NOW, v: 2, c: 100 })).toEqual([{ t: NOW, v: 2, c: 100 }]);

    const long = Array.from({ length: POOL_HISTORY_MAX_SAMPLES }, (_, i) => ({
      t: NOW - (POOL_HISTORY_MAX_SAMPLES - i) * MINUTE_MS,
      v: i % 2 === 0 ? 50 : 60,
      c: i % 2 === 0 ? 100 : 200,
    }));
    expect(appendPoolSample(long, { t: NOW, v: 1, c: 300 }).length).toBe(
      POOL_HISTORY_MAX_SAMPLES
    );
  });
});

describe('QuotaPool rendering', () => {
  const entries: QuotaFileEntry[] = [
    { file: { name: 'one.json', type: 'claude' }, type: 'claude' },
    { file: { name: 'two.json', type: 'claude' }, type: 'claude' },
  ];
  const quotaFor = (entry: QuotaFileEntry) => ({
    status: 'success',
    windows: [
      {
        label: '7-day',
        usedPercent: entry.file.name === 'one.json' ? 25 : 50,
        resetAtMs: NOW + DAY_MS,
        periodHours: 168,
      },
    ],
  });

  test('sums credentials into one pool with recorded history', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaPool, {
        entries,
        quotaFor,
        displayNameFor: (name: string) => name,
        resolvedTheme: 'dark' as const,
        now: NOW,
        historyFor: () => [
          { t: NOW - 2 * HOUR_MS, v: 135, c: 200 },
          { t: NOW - HOUR_MS, v: 130, c: 200 },
        ],
      })
    );
    // 75 + 50 of 200.
    expect(markup).toContain('125%');
    expect(markup).toContain('200%');
    expect(markup).toContain('role="img"');
  });

  test('renders nothing without loaded quota', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaPool, {
        entries,
        quotaFor: () => undefined,
        displayNameFor: (name: string) => name,
        resolvedTheme: 'dark' as const,
        now: NOW,
        historyFor: () => [],
      })
    );
    expect(markup).toBe('');
  });
});

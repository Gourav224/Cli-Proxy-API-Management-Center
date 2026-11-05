import { describe, expect, test } from 'bun:test';
import {
  createStaggeredTaskQueue,
  isQuotaEntryDueForAutoRefresh,
  MIN_QUOTA_AUTO_REFRESH_MS,
  resolveQuotaAutoRefreshCadenceMs,
} from '@/features/quota/quotaRefreshQueue';

describe('quotaRefreshQueue', () => {
  test('clamps auto-refresh cadence to at least 60s and honors Off', () => {
    expect(resolveQuotaAutoRefreshCadenceMs('off')).toBeNull();
    expect(resolveQuotaAutoRefreshCadenceMs(5000)).toBe(MIN_QUOTA_AUTO_REFRESH_MS);
    expect(resolveQuotaAutoRefreshCadenceMs(10000)).toBe(MIN_QUOTA_AUTO_REFRESH_MS);
    expect(resolveQuotaAutoRefreshCadenceMs(60000)).toBe(60_000);
    expect(resolveQuotaAutoRefreshCadenceMs(120000)).toBe(120_000);

    expect(isQuotaEntryDueForAutoRefresh('idle', undefined, 100_000, 60_000)).toBe(true);
    expect(isQuotaEntryDueForAutoRefresh('loading', 90_000, 100_000, 60_000)).toBe(false);
    expect(isQuotaEntryDueForAutoRefresh('success', 50_000, 100_000, 60_000)).toBe(false);
    expect(isQuotaEntryDueForAutoRefresh('success', 40_000, 100_000, 60_000)).toBe(true);
  });

  test('enforces maxConcurrency <= 3, staggers starts, and deduplicates per key', async () => {
    let currentNow = 1_000;
    let nextId = 1;
    const timers = new Map<number, { runAt: number; fn: () => void }>();

    const advance = (ms: number) => {
      currentNow += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.runAt <= currentNow)
          .sort((a, b) => a[1].runAt - b[1].runAt)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    };

    const queue = createStaggeredTaskQueue({
      maxConcurrency: 3,
      staggerMs: 160,
      now: () => currentNow,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { runAt: currentNow + ms, fn });
        return id;
      },
      clearTimer: (id) => timers.delete(id as number),
    });

    const startTimes: Array<{ key: string; at: number }> = [];
    const resolvers = new Map<string, () => void>();
    let peakActive = 0;

    const enqueueCred = (key: string) =>
      queue.enqueue(key, () => {
        startTimes.push({ key, at: currentNow });
        peakActive = Math.max(peakActive, queue.activeCount());
        return new Promise<string>((resolve) => {
          resolvers.set(key, () => resolve(key));
        });
      });

    const p1 = enqueueCred('c1');
    // Duplicate key while running/queued returns same promise without starting twice.
    const p1Dup = enqueueCred('c1');
    const p2 = enqueueCred('c2');
    const p3 = enqueueCred('c3');
    const p4 = enqueueCred('c4');
    const p5 = enqueueCred('c5');

    expect(p1).toBe(p1Dup);
    expect(startTimes).toEqual([{ key: 'c1', at: 1_000 }]);

    advance(160);
    expect(startTimes.map((s) => s.key)).toEqual(['c1', 'c2']);

    advance(160);
    expect(startTimes.map((s) => s.key)).toEqual(['c1', 'c2', 'c3']);
    expect(queue.activeCount()).toBe(3);

    // Concurrency cap is 3: advancing time does NOT launch c4 until one finishes.
    advance(500);
    expect(startTimes.map((s) => s.key)).toEqual(['c1', 'c2', 'c3']);

    resolvers.get('c1')!();
    await p1;
    await Promise.resolve();
    expect(startTimes.map((s) => s.key)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(peakActive).toBeLessThanOrEqual(3);

    // Clear pending cancels c5 cleanly before it starts.
    queue.clearPending();
    expect(await p5).toBeUndefined();

    resolvers.get('c2')!();
    resolvers.get('c3')!();
    resolvers.get('c4')!();
    await Promise.all([p2, p3, p4]);
    expect(queue.activeCount()).toBe(0);
  });
});

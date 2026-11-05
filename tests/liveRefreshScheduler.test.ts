import { describe, expect, test } from 'bun:test';
import {
  computeBackoffDelayMs,
  createLiveRefreshScheduler,
  DEFAULT_LIVE_REFRESH_INTERVAL,
  parseLiveRefreshInterval,
} from '@/utils/liveRefreshScheduler';

function createFakeTimers(initialNow = 1_000) {
  let currentNow = initialNow;
  let nextId = 1;
  const timers = new Map<number, { runAt: number; fn: () => void }>();

  return {
    now: () => currentNow,
    advance(ms: number) {
      currentNow += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, item]) => item.runAt <= currentNow)
          .sort((a, b) => a[1].runAt - b[1].runAt)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { runAt: currentNow + ms, fn });
      return id;
    },
    clearTimer(id: unknown) {
      timers.delete(id as number);
    },
    pendingTimerCount() {
      return timers.size;
    },
  };
}

describe('liveRefreshScheduler', () => {
  test('parses persisted intervals safely and defaults to 10s', () => {
    expect(parseLiveRefreshInterval(null)).toBe(DEFAULT_LIVE_REFRESH_INTERVAL);
    expect(parseLiveRefreshInterval('off')).toBe('off');
    expect(parseLiveRefreshInterval('5000')).toBe(5000);
    expect(parseLiveRefreshInterval(10000)).toBe(10000);
    expect(parseLiveRefreshInterval('30000')).toBe(30000);
    expect(parseLiveRefreshInterval('60000')).toBe(60000);
    expect(parseLiveRefreshInterval('999')).toBe(10000);
  });

  test('schedules non-overlapping post-completion ticks and persists interval changes', async () => {
    const clock = createFakeTimers();
    const persisted: Array<'off' | number> = [];
    let calls = 0;
    let resolveCurrent: (() => void) | null = null;

    const scheduler = createLiveRefreshScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onPersistInterval: (next) => persisted.push(next),
    });

    scheduler.setHandler(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          resolveCurrent = resolve;
        })
    );

    expect(clock.pendingTimerCount()).toBe(1);
    clock.advance(10_000);
    expect(calls).toBe(1);
    expect(scheduler.getSnapshot().isRefreshing).toBe(true);

    // Slow request takes 15s: must NOT overlap a second request while in flight.
    clock.advance(15_000);
    expect(calls).toBe(1);

    resolveCurrent!();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.getSnapshot().isRefreshing).toBe(false);
    expect(scheduler.getSnapshot().lastUpdatedAt).toBe(26_000);

    scheduler.setIntervalValue(5000);
    expect(persisted).toEqual([5000]);
    clock.advance(5_000);
    expect(calls).toBe(2);

    scheduler.setIntervalValue('off');
    expect(clock.pendingTimerCount()).toBe(0);
    scheduler.dispose();
  });

  test('pauses while hidden and refreshes immediately when visible again', async () => {
    const clock = createFakeTimers();
    const sources: string[] = [];
    const scheduler = createLiveRefreshScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.setHandler(({ source }) => {
      sources.push(source);
    });

    scheduler.setHidden(true);
    expect(clock.pendingTimerCount()).toBe(0);
    clock.advance(60_000);
    expect(sources).toEqual([]);

    scheduler.setHidden(false);
    await Promise.resolve();
    expect(sources).toEqual(['auto']);
    scheduler.dispose();
  });

  test('deduplicates concurrent refreshes and backs off exponentially after errors', async () => {
    const clock = createFakeTimers();
    let shouldFail = true;
    let calls = 0;

    expect(computeBackoffDelayMs(10_000, 0)).toBe(10_000);
    expect(computeBackoffDelayMs(10_000, 1)).toBe(20_000);
    expect(computeBackoffDelayMs(10_000, 2)).toBe(40_000);

    const scheduler = createLiveRefreshScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.setHandler(async () => {
      calls += 1;
      await Promise.resolve();
      if (shouldFail) throw new Error('upstream 502');
    });

    const p1 = scheduler.trigger('auto');
    const p2 = scheduler.trigger('auto');
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(scheduler.getSnapshot().consecutiveErrors).toBe(1);

    // Backed off to 20s instead of 10s: advancing 10s must not fire yet.
    clock.advance(10_000);
    expect(calls).toBe(1);
    shouldFail = false;
    clock.advance(10_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(scheduler.getSnapshot().consecutiveErrors).toBe(0);
    scheduler.dispose();
  });

  test('ignores stale completions across session revision changes', async () => {
    const clock = createFakeTimers();
    let revision = 1;
    let finishInFlight: (() => void) | null = null;

    const scheduler = createLiveRefreshScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      getSessionRevision: () => revision,
    });

    scheduler.setHandler(
      () =>
        new Promise<void>((resolve) => {
          finishInFlight = resolve;
        })
    );

    const p = scheduler.trigger('manual');
    revision = 2;
    scheduler.resetSession();
    finishInFlight!();
    await p;

    expect(scheduler.getSnapshot().lastUpdatedAt).toBeNull();
    scheduler.dispose();
  });
});

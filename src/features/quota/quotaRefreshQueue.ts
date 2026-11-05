/**
 * Concurrency-limited, staggered task queue for per-credential quota requests.
 *
 * Upstream provider quota endpoints (Claude, Antigravity, Codex, etc.) rate-limit
 * burst traffic. This queue enforces:
 * - maxConcurrency <= 3 simultaneous in-flight requests
 * - staggerMs spacing between consecutive task starts
 * - per-key in-flight deduplication (manual + batch + auto never double-fetch)
 * - minCadenceMs = 60_000 helper for background auto-refresh eligibility
 */

export const MAX_QUOTA_CONCURRENCY = 3;
export const QUOTA_STAGGER_MS = 60;
export const MIN_QUOTA_AUTO_REFRESH_MS = 60_000;

export function resolveQuotaAutoRefreshCadenceMs(
  globalInterval: 'off' | number
): number | null {
  if (globalInterval === 'off') return null;
  if (!Number.isFinite(globalInterval) || globalInterval <= 0) {
    return MIN_QUOTA_AUTO_REFRESH_MS;
  }
  return Math.max(MIN_QUOTA_AUTO_REFRESH_MS, globalInterval);
}

export function isQuotaEntryDueForAutoRefresh(
  status: 'idle' | 'loading' | 'success' | 'error' | undefined,
  fetchedAtMs: number | undefined,
  nowMs: number,
  cadenceMs: number
): boolean {
  if (status === 'loading') return false;
  if (!status || status === 'idle') return true;
  if (fetchedAtMs === undefined) return true;
  return nowMs - fetchedAtMs >= Math.max(MIN_QUOTA_AUTO_REFRESH_MS, cadenceMs);
}

export interface StaggeredQueueOptions {
  maxConcurrency?: number;
  staggerMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

interface PendingItem<T> {
  key: string;
  task: () => Promise<T>;
  resolve: (value: T | undefined) => void;
  reject: (reason: unknown) => void;
  outerPromise?: Promise<T | undefined>;
  epoch: number;
}

export interface StaggeredTaskQueue {
  enqueue<T>(key: string, task: () => Promise<T>, priority?: 'front' | 'back'): Promise<T | undefined>;
  isQueuedOrRunning(key: string): boolean;
  activeCount(): number;
  pendingCount(): number;
  clearPending(): void;
}

export function createStaggeredTaskQueue(
  options: StaggeredQueueOptions = {}
): StaggeredTaskQueue {
  const {
    maxConcurrency = MAX_QUOTA_CONCURRENCY,
    staggerMs = QUOTA_STAGGER_MS,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  } = options;

  const queue: Array<PendingItem<unknown>> = [];
  const inFlightPromises = new Map<string, Promise<unknown>>();
  const queuedPromises = new Map<string, Promise<unknown>>();
  let active = 0;
  let lastLaunchAt = -Infinity;
  let staggerTimer: unknown = null;
  let epoch = 0;

  const cancelStaggerTimer = () => {
    if (staggerTimer !== null) {
      clearTimer(staggerTimer);
      staggerTimer = null;
    }
  };

  const pump = () => {
    cancelStaggerTimer();
    while (active < maxConcurrency && queue.length > 0) {
      const currentNow = now();
      const elapsed = currentNow - lastLaunchAt;
      if (staggerMs > 0 && elapsed < staggerMs) {
        const waitMs = staggerMs - elapsed;
        staggerTimer = setTimer(() => {
          staggerTimer = null;
          pump();
        }, waitMs);
        return;
      }

      const item = queue.shift()!;
      queuedPromises.delete(item.key);
      if (item.epoch !== epoch) {
        item.resolve(undefined);
        continue;
      }

      active += 1;
      lastLaunchAt = currentNow;

      const runPromise = (async () => {
        try {
          const result = await item.task();
          item.resolve(result);
          return result;
        } catch (err) {
          item.reject(err);
          throw err;
        } finally {
          inFlightPromises.delete(item.key);
          active = Math.max(0, active - 1);
          pump();
        }
      })();

      void runPromise.catch(() => undefined);
      if (item.outerPromise) {
        inFlightPromises.set(item.key, item.outerPromise);
      }
    }
  };

  return {
    enqueue<T>(
      key: string,
      task: () => Promise<T>,
      priority: 'front' | 'back' = 'back'
    ): Promise<T | undefined> {
      const existingInFlight = inFlightPromises.get(key);
      if (existingInFlight) {
        return existingInFlight as Promise<T | undefined>;
      }
      const existingQueued = queuedPromises.get(key);
      if (existingQueued) {
        return existingQueued as Promise<T | undefined>;
      }

      const itemEpoch = epoch;
      let createdEntry!: PendingItem<unknown>;
      const promise = new Promise<T | undefined>((resolve, reject) => {
        createdEntry = {
          key,
          task: task as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
          epoch: itemEpoch,
        };
      });
      createdEntry.outerPromise = promise;
      if (priority === 'front') {
        queue.unshift(createdEntry);
      } else {
        queue.push(createdEntry);
      }

      queuedPromises.set(key, promise);
      pump();
      return promise;
    },
    isQueuedOrRunning(key: string) {
      return inFlightPromises.has(key) || queuedPromises.has(key);
    },
    activeCount() {
      return active;
    },
    pendingCount() {
      return queue.length;
    },
    clearPending() {
      epoch += 1;
      cancelStaggerTimer();
      while (queue.length > 0) {
        const item = queue.shift()!;
        queuedPromises.delete(item.key);
        item.resolve(undefined);
      }
    },
  };
}

export const sharedQuotaRefreshQueue = createStaggeredTaskQueue();

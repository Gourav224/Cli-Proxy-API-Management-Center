/**
 * Global live-data refresh scheduler.
 *
 * Pure and React-free so tests can drive timers, visibility transitions,
 * error backoff, in-flight deduplication, and session generation boundaries
 * deterministically without touching a real clock.
 */

export type LiveRefreshInterval = 'off' | 5000 | 10000 | 30000 | 60000;

export type RefreshSource = 'manual' | 'auto';

export interface RefreshContext {
  source: RefreshSource;
}

export type ScheduledRefreshFn = (context: RefreshContext) => void | Promise<void>;

export const LIVE_REFRESH_INTERVALS: readonly LiveRefreshInterval[] = [
  'off',
  5000,
  10000,
  30000,
  60000,
] as const;

export const DEFAULT_LIVE_REFRESH_INTERVAL: LiveRefreshInterval = 10000;
export const LIVE_REFRESH_STORAGE_KEY = 'cpamc:live-refresh-interval';
export const MAX_LIVE_REFRESH_BACKOFF_MS = 300_000;

export function parseLiveRefreshInterval(raw: unknown): LiveRefreshInterval {
  if (raw === 'off') return 'off';
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (numeric === 5000 || numeric === 10000 || numeric === 30000 || numeric === 60000) {
    return numeric;
  }
  return DEFAULT_LIVE_REFRESH_INTERVAL;
}

export function computeBackoffDelayMs(
  baseMs: number,
  consecutiveErrors: number,
  maxBackoffMs = MAX_LIVE_REFRESH_BACKOFF_MS
): number {
  if (consecutiveErrors <= 0) return baseMs;
  const factor = Math.pow(2, Math.min(consecutiveErrors, 8));
  return Math.min(maxBackoffMs, baseMs * factor);
}

export interface LiveRefreshSnapshot {
  interval: LiveRefreshInterval;
  isRefreshing: boolean;
  lastUpdatedAt: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  autoRefreshEnabled: boolean;
  hidden: boolean;
}

export interface LiveRefreshSchedulerOptions {
  initialInterval?: LiveRefreshInterval;
  initialHidden?: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  onPersistInterval?: (interval: LiveRefreshInterval) => void;
  getSessionRevision?: () => number;
}

export interface LiveRefreshScheduler {
  getSnapshot(): LiveRefreshSnapshot;
  subscribe(listener: () => void): () => void;
  setIntervalValue(next: LiveRefreshInterval): void;
  setHandler(
    handler: ScheduledRefreshFn | null,
    options?: { enabled?: boolean; autoRefresh?: boolean }
  ): void;
  setShellRunner(runner: ScheduledRefreshFn | null): void;
  setConnected(connected: boolean): void;
  setHidden(hidden: boolean): void;
  trigger(source?: RefreshSource): Promise<void>;
  markUpdated(atMs?: number): void;
  resetSession(): void;
  dispose(): void;
}

export function createLiveRefreshScheduler(
  options: LiveRefreshSchedulerOptions = {}
): LiveRefreshScheduler {
  const {
    initialInterval = DEFAULT_LIVE_REFRESH_INTERVAL,
    initialHidden = false,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    onPersistInterval,
    getSessionRevision = () => 0,
  } = options;

  const listeners = new Set<() => void>();
  let interval: LiveRefreshInterval = initialInterval;
  let isRefreshing = false;
  let lastUpdatedAt: number | null = null;
  let consecutiveErrors = 0;
  let lastError: string | null = null;
  let hidden = initialHidden;
  let connected = true;

  let pageHandler: ScheduledRefreshFn | null = null;
  let shellRunner: ScheduledRefreshFn | null = null;
  let handlerEnabled = false;
  let handlerAutoRefresh = true;

  let timerId: unknown = null;
  let inFlightPromise: Promise<void> | null = null;
  let sessionGeneration = 0;
  let routeGeneration = 0;

  let snapshot: LiveRefreshSnapshot = {
    interval,
    isRefreshing,
    lastUpdatedAt,
    consecutiveErrors,
    lastError,
    autoRefreshEnabled: false,
    hidden,
  };

  const canAutoRefresh = (): boolean =>
    connected &&
    interval !== 'off' &&
    handlerEnabled &&
    handlerAutoRefresh &&
    Boolean(pageHandler || shellRunner);

  const emit = () => {
    const nextAuto = canAutoRefresh();
    if (
      snapshot.interval === interval &&
      snapshot.isRefreshing === isRefreshing &&
      snapshot.lastUpdatedAt === lastUpdatedAt &&
      snapshot.consecutiveErrors === consecutiveErrors &&
      snapshot.lastError === lastError &&
      snapshot.autoRefreshEnabled === nextAuto &&
      snapshot.hidden === hidden
    ) {
      return;
    }
    snapshot = {
      interval,
      isRefreshing,
      lastUpdatedAt,
      consecutiveErrors,
      lastError,
      autoRefreshEnabled: nextAuto,
      hidden,
    };
    listeners.forEach((listener) => listener());
  };

  const cancelTimer = () => {
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  };

  const scheduleNext = (overrideDelayMs?: number) => {
    cancelTimer();
    if (hidden || isRefreshing || !canAutoRefresh() || interval === 'off') {
      return;
    }
    const delayMs =
      overrideDelayMs ?? computeBackoffDelayMs(interval, consecutiveErrors);
    timerId = setTimer(() => {
      timerId = null;
      void trigger('auto');
    }, Math.max(0, delayMs));
  };

  const trigger = async (source: RefreshSource = 'manual'): Promise<void> => {
    if (!connected) return;
    if (source === 'auto' && (hidden || !canAutoRefresh())) return;

    if (source === 'manual' && consecutiveErrors > 0) {
      consecutiveErrors = 0;
      lastError = null;
      emit();
    }

    // Deduplicate concurrent requests: never overlap in-flight refreshes.
    if (inFlightPromise) {
      return inFlightPromise;
    }

    const activeRunner = shellRunner ?? pageHandler;
    if (!activeRunner) return;

    cancelTimer();
    const startSessionGen = sessionGeneration;
    const startRouteGen = routeGeneration;
    const startRevision = getSessionRevision();

    isRefreshing = true;
    emit();

    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        await activeRunner({ source });
        const staleSession =
          startSessionGen !== sessionGeneration || startRevision !== getSessionRevision();
        if (staleSession) return;

        if (startRouteGen === routeGeneration) {
          consecutiveErrors = 0;
          lastError = null;
          lastUpdatedAt = now();
        }
      } catch (err: unknown) {
        const staleSession =
          startSessionGen !== sessionGeneration || startRevision !== getSessionRevision();
        if (staleSession) return;

        if (startRouteGen === routeGeneration) {
          consecutiveErrors += 1;
          lastError = err instanceof Error ? err.message : String(err ?? 'Refresh failed');
        }
      } finally {
        if (inFlightPromise === run) {
          inFlightPromise = null;
        }
        if (startSessionGen === sessionGeneration) {
          isRefreshing = false;
          emit();
          scheduleNext();
        }
      }
    })();

    inFlightPromise = run;
    return run;
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setIntervalValue(next) {
      if (interval === next) return;
      interval = next;
      consecutiveErrors = 0;
      lastError = null;
      onPersistInterval?.(next);
      emit();
      scheduleNext();
    },
    setHandler(handler, opts = {}) {
      const nextEnabled = Boolean(handler) && (opts.enabled ?? true);
      const nextAuto = opts.autoRefresh ?? true;
      const changedHandler = pageHandler !== handler;

      pageHandler = handler;
      handlerEnabled = nextEnabled;
      handlerAutoRefresh = nextAuto;

      if (changedHandler) {
        routeGeneration += 1;
        consecutiveErrors = 0;
        lastError = null;
      }
      emit();
      scheduleNext();
    },
    setShellRunner(runner) {
      shellRunner = runner;
      emit();
      scheduleNext();
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        cancelTimer();
      }
      emit();
      if (connected) {
        scheduleNext();
      }
    },
    setHidden(nextHidden) {
      if (hidden === nextHidden) return;
      hidden = nextHidden;
      emit();
      if (hidden) {
        cancelTimer();
        return;
      }
      // Visible again: refresh immediately when live refresh is active.
      if (canAutoRefresh()) {
        void trigger('auto');
      }
    },
    trigger,
    markUpdated(atMs) {
      if (!connected) return;
      lastUpdatedAt = atMs ?? now();
      consecutiveErrors = 0;
      lastError = null;
      emit();
      if (!isRefreshing) {
        scheduleNext();
      }
    },
    resetSession() {
      sessionGeneration += 1;
      routeGeneration += 1;
      inFlightPromise = null;
      isRefreshing = false;
      lastUpdatedAt = null;
      consecutiveErrors = 0;
      lastError = null;
      cancelTimer();
      emit();
    },
    dispose() {
      cancelTimer();
      listeners.clear();
    },
  };
}

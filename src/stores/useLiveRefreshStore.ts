import { useSyncExternalStore } from 'react';
import { apiClient } from '@/services/api/client';
import {
  createLiveRefreshScheduler,
  DEFAULT_LIVE_REFRESH_INTERVAL,
  LIVE_REFRESH_STORAGE_KEY,
  parseLiveRefreshInterval,
  type LiveRefreshInterval,
  type LiveRefreshSnapshot,
  type RefreshSource,
  type ScheduledRefreshFn,
} from '@/utils/liveRefreshScheduler';

function readStoredInterval(): LiveRefreshInterval {
  if (typeof window === 'undefined') return DEFAULT_LIVE_REFRESH_INTERVAL;
  try {
    const raw = window.localStorage.getItem(LIVE_REFRESH_STORAGE_KEY);
    if (raw === null) return DEFAULT_LIVE_REFRESH_INTERVAL;
    return parseLiveRefreshInterval(raw);
  } catch {
    return DEFAULT_LIVE_REFRESH_INTERVAL;
  }
}

function persistInterval(next: LiveRefreshInterval): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LIVE_REFRESH_STORAGE_KEY, String(next));
  } catch {
    // Ignore storage quota or private mode errors.
  }
}

export const liveRefreshScheduler = createLiveRefreshScheduler({
  initialInterval: readStoredInterval(),
  initialHidden: typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false,
  onPersistInterval: persistInterval,
  getSessionRevision: () => apiClient.getConnectionRevision(),
});

let visibilityListenerAttached = false;

export function attachLiveRefreshVisibilityListener(): () => void {
  if (typeof document === 'undefined' || visibilityListenerAttached) {
    return () => {};
  }
  visibilityListenerAttached = true;
  const onVisibilityChange = () => {
    liveRefreshScheduler.setHidden(document.visibilityState === 'hidden');
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityListenerAttached = false;
  };
}

export function useLiveRefreshSnapshot(): LiveRefreshSnapshot {
  return useSyncExternalStore(
    liveRefreshScheduler.subscribe,
    liveRefreshScheduler.getSnapshot,
    liveRefreshScheduler.getSnapshot
  );
}

export const setLiveRefreshInterval = (next: LiveRefreshInterval) =>
  liveRefreshScheduler.setIntervalValue(next);

export const triggerLiveRefresh = (source: RefreshSource = 'manual') =>
  liveRefreshScheduler.trigger(source);

export const markLiveDataUpdated = (atMs?: number) =>
  liveRefreshScheduler.markUpdated(atMs);

export const resetLiveRefreshSession = () =>
  liveRefreshScheduler.resetSession();

export const registerShellRefreshRunner = (runner: ScheduledRefreshFn | null) =>
  liveRefreshScheduler.setShellRunner(runner);

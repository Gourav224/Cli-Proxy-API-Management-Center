import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveRefreshSnapshot, useQuotaStore } from '@/stores';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getQuotaMap, QUOTA_ADAPTERS } from '../providers';
import type { QuotaFileEntry } from '../logic';
import {
  isQuotaEntryDueForAutoRefresh,
  MIN_QUOTA_AUTO_REFRESH_MS,
  resolveQuotaAutoRefreshCadenceMs,
  sharedQuotaRefreshQueue,
} from '../quotaRefreshQueue';
import { runQueuedQuotaFetch } from './quotaFetchRunner';

/**
 * Automatically loads uncached credentials on mount (no manual click needed)
 * and refreshes stale credentials on a separate >= 60s cadence with bounded
 * concurrency (<= 3) and 160ms staggering while the tab is visible.
 */
export function useQuotaAutoRefresh(
  entries: readonly QuotaFileEntry[],
  enabled: boolean
): void {
  const { t } = useTranslation();
  const { interval, hidden } = useLiveRefreshSnapshot();
  const cacheGeneration = useQuotaStore((state) => state.cacheGeneration);

  useEffect(() => {
    return () => {
      // Clear queued tasks when session cache generation resets.
      sharedQuotaRefreshQueue.clearPending();
    };
  }, [cacheGeneration]);

  useEffect(() => {
    if (!enabled || hidden || entries.length === 0) return;

    const cadenceMs = resolveQuotaAutoRefreshCadenceMs(interval);

    const sweep = (initialMountOnly: boolean) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      const now = Date.now();
      const { quotaFetchedAt, quotaRefreshing } = useQuotaStore.getState();

      entries.forEach((entry) => {
        if (entry.file.disabled) return;
        const cacheKey = getQuotaCacheKey(entry.file);
        if (quotaRefreshing[cacheKey] || sharedQuotaRefreshQueue.isQueuedOrRunning(cacheKey)) {
          return;
        }
        const adapter = QUOTA_ADAPTERS[entry.type];
        const existing = getQuotaMap(adapter)[cacheKey];

        if (initialMountOnly) {
          if (!existing || existing.status === 'idle') {
            void runQueuedQuotaFetch({
              file: entry.file,
              adapter,
              t,
              priority: 'back',
              preserveSuccessOnError: false,
            });
          }
          return;
        }

        if (
          cadenceMs !== null &&
          isQuotaEntryDueForAutoRefresh(existing?.status, quotaFetchedAt[cacheKey], now, cadenceMs)
        ) {
          void runQueuedQuotaFetch({
            file: entry.file,
            adapter,
            t,
            priority: 'back',
            preserveSuccessOnError: true,
          });
        }
      });
    };

    // Always ensure idle credentials load on mount; if auto-refresh is enabled, also refresh stale ones.
    sweep(cadenceMs === null);

    if (cadenceMs === null) return;

    const checkIntervalMs = Math.min(15_000, Math.max(5_000, Math.floor(MIN_QUOTA_AUTO_REFRESH_MS / 4)));
    const timer = setInterval(() => {
      sweep(false);
    }, checkIntervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [enabled, entries, hidden, interval, t]);
}

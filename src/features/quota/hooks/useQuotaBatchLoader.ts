/**
 * Batch quota loader backed by the shared concurrency-limited (<= 3),
 * staggered queue so manual "Refresh all" and auto-refresh never burst
 * upstream provider APIs or blank out existing quota cards.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QUOTA_ADAPTERS } from '../providers';
import type { QuotaFileEntry } from '../logic';
import { runQueuedQuotaFetch } from './quotaFetchRunner';

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (targets: QuotaFileEntry[], options?: { background?: boolean }) => {
      if (loadingRef.current) return;
      const activeTargets = targets.filter((entry) => !entry.file.disabled);
      if (activeTargets.length === 0) return;

      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      setBatchLoading(true);

      try {
        await Promise.allSettled(
          activeTargets.map((entry) =>
            runQueuedQuotaFetch({
              file: entry.file,
              adapter: QUOTA_ADAPTERS[entry.type],
              t,
              priority: options?.background ? 'back' : 'front',
              preserveSuccessOnError: Boolean(options?.background),
            })
          )
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [t]
  );

  return { batchLoading, loadQuota };
}

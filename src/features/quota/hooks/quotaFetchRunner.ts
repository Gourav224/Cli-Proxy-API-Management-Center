import type { TFunction } from 'i18next';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
} from '@/stores';
import type { AuthFileItem } from '@/types';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { enrichQuotaInBackground } from '../quotaEnrichment';
import { getQuotaMap, getQuotaSetter, type QuotaAdapter } from '../providers';
import { sharedQuotaRefreshQueue } from '../quotaRefreshQueue';

export interface RunSingleQuotaFetchOptions {
  file: AuthFileItem;
  adapter: QuotaAdapter;
  t: TFunction;
  priority?: 'front' | 'back';
  preserveSuccessOnError?: boolean;
}

export interface SingleQuotaFetchOutcome {
  ok: boolean;
  committed: boolean;
  errorMessage?: string;
}

export async function runQueuedQuotaFetch(
  options: RunSingleQuotaFetchOptions
): Promise<SingleQuotaFetchOutcome> {
  const {
    file,
    adapter,
    t,
    priority = 'back',
    preserveSuccessOnError = false,
  } = options;

  if (file.disabled) {
    return { ok: false, committed: false };
  }

  const cacheKey = getQuotaCacheKey(file);
  const setQuota = getQuotaSetter(adapter);
  const store = useQuotaStore.getState();
  const existing = getQuotaMap(adapter)[cacheKey];
  const hadSuccess = existing?.status === 'success';

  store.setQuotaRefreshing(cacheKey, true);
  if (!hadSuccess && existing?.status !== 'loading') {
    const initialGen = captureQuotaCacheGeneration(file.name);
    commitIfQuotaCacheCurrent(
      initialGen,
      () => {
        setQuota((prev) => ({
          ...prev,
          [cacheKey]: adapter.buildLoadingState(),
        }));
      },
      file.name
    );
  }

  const outcome = await sharedQuotaRefreshQueue.enqueue<SingleQuotaFetchOutcome>(
    cacheKey,
    async () => {
      const cacheGeneration = captureQuotaCacheGeneration(file.name);
      try {
        const data = await adapter.fetchQuota(file, t);
        let committed = false;
        commitIfQuotaCacheCurrent(
          cacheGeneration,
          () => {
            const successState = adapter.buildSuccessState(data);
            setQuota((prev) => ({
              ...prev,
              [cacheKey]: successState,
            }));
            useQuotaStore.getState().markQuotaFetched(cacheKey, Date.now());
            committed = true;
            void enrichQuotaInBackground(adapter, file, data, successState, t);
          },
          file.name
        );
        return { ok: true, committed };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        let committed = false;
        commitIfQuotaCacheCurrent(
          cacheGeneration,
          () => {
            const current = getQuotaMap(adapter)[cacheKey];
            // During silent background auto-refresh, retain already-rendered quota data
            // instead of replacing a healthy card with a transient upstream error banner.
            if (!(preserveSuccessOnError && current?.status === 'success')) {
              setQuota((prev) => ({
                ...prev,
                [cacheKey]: adapter.buildErrorState(message, status),
              }));
            }
            useQuotaStore.getState().markQuotaFetched(cacheKey, Date.now());
            committed = true;
          },
          file.name
        );
        return { ok: false, committed, errorMessage: message };
      } finally {
        useQuotaStore.getState().setQuotaRefreshing(cacheKey, false);
      }
    },
    priority
  );

  if (!outcome) {
    useQuotaStore.getState().setQuotaRefreshing(cacheKey, false);
    return { ok: false, committed: false };
  }
  return outcome;
}

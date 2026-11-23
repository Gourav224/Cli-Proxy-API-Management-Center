import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { buildTimelineLane } from './quotaTimelineModel';
import { nextRecoveryMs } from './resetSchedule';

export interface ProviderPoolBrief {
  provider: QuotaProviderType;
  totalAccounts: number;
  loadedAccounts: number;
  exhaustedAccounts: number;
  lowAccounts: number;
  averageRemainingPercent: number | null;
}

export interface FleetQuotaSummary {
  total: number;
  loaded: number;
  healthy: number;
  low: number;
  exhausted: number;
  errors: number;
  attentionCount: number;
  soonestReset: {
    displayName: string;
    provider: QuotaProviderType;
    atMs: number;
  } | null;
  byProvider: ProviderPoolBrief[];
}

/**
 * Derive human-readable, disambiguated display labels for quota entries
 * (preferring email/projectId via deriveAuthFileIdentity).
 */
export function buildQuotaDisplayNameMap(
  entries: readonly QuotaFileEntry[]
): Map<string, string> {
  const counts = new Map<string, number>();
  const identities = entries.map((entry) => {
    const id = deriveAuthFileIdentity(entry.file);
    const label = id.primary || entry.file.name;
    const key = `${entry.type}:${label.toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { entry, id, label, key };
  });

  const out = new Map<string, string>();
  identities.forEach(({ entry, id, label, key }) => {
    if ((counts.get(key) ?? 0) > 1 && id.secondary) {
      // Append short suffix (e.g. plan or hash tail) when same email appears twice in one provider
      const tail = id.secondary.split('-').pop();
      out.set(entry.file.name, tail && tail.length <= 12 ? `${label} (${tail})` : label);
    } else {
      out.set(entry.file.name, label);
    }
  });
  return out;
}

/** Lowest remaining percentage across an account's limits; null when none is reported. */
export function minQuotaRemaining(
  entry: QuotaFileEntry,
  quota: QuotaCardState,
  displayName: string
): number | null {
  const lane = buildTimelineLane({
    name: entry.file.name,
    displayName,
    provider: entry.type,
    quota,
  });
  return lane.limits.length > 0 ? Math.min(...lane.limits.map((l) => l.remaining)) : lane.remaining;
}

export function summarizeQuotaFleet(
  entries: readonly QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  displayNameFor: (name: string) => string,
  now: number
): FleetQuotaSummary {
  let loaded = 0;
  let healthy = 0;
  let low = 0;
  let exhausted = 0;
  let errors = 0;
  let soonestReset: FleetQuotaSummary['soonestReset'] = null;

  const providerBuckets = new Map<
    QuotaProviderType,
    {
      total: number;
      loaded: number;
      exhausted: number;
      low: number;
      remainingSum: number;
      remainingCount: number;
    }
  >();

  for (const entry of entries) {
    let bucket = providerBuckets.get(entry.type);
    if (!bucket) {
      bucket = {
        total: 0,
        loaded: 0,
        exhausted: 0,
        low: 0,
        remainingSum: 0,
        remainingCount: 0,
      };
      providerBuckets.set(entry.type, bucket);
    }
    bucket.total += 1;

    const quota = quotaFor(entry);
    const status = quota?.status;
    if (status === 'error') {
      errors += 1;
      continue;
    }
    if (status !== 'success' || !quota) {
      continue;
    }

    loaded += 1;
    bucket.loaded += 1;

    const minRemaining = minQuotaRemaining(entry, quota, displayNameFor(entry.file.name));

    if (minRemaining !== null && Number.isFinite(minRemaining)) {
      bucket.remainingSum += minRemaining;
      bucket.remainingCount += 1;

      if (minRemaining <= 2) {
        exhausted += 1;
        bucket.exhausted += 1;
      } else if (minRemaining < 20) {
        low += 1;
        bucket.low += 1;
      } else {
        healthy += 1;
      }
    } else {
      healthy += 1;
    }

    const recoveryAt = nextRecoveryMs(entry.type, quota, now);
    if (
      recoveryAt !== null &&
      recoveryAt > now &&
      (soonestReset === null || recoveryAt < soonestReset.atMs)
    ) {
      soonestReset = {
        displayName: displayNameFor(entry.file.name),
        provider: entry.type,
        atMs: recoveryAt,
      };
    }
  }

  const byProvider: ProviderPoolBrief[] = Array.from(providerBuckets.entries()).map(
    ([provider, b]) => ({
      provider,
      totalAccounts: b.total,
      loadedAccounts: b.loaded,
      exhaustedAccounts: b.exhausted,
      lowAccounts: b.low,
      averageRemainingPercent:
        b.remainingCount > 0 ? b.remainingSum / b.remainingCount : null,
    })
  );

  return {
    total: entries.length,
    loaded,
    healthy,
    low,
    exhausted,
    errors,
    attentionCount: exhausted + low + errors,
    soonestReset,
    byProvider,
  };
}

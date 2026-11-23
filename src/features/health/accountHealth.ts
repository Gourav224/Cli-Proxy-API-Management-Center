/**
 * Per-account health score (0-100) derived from what the auth-files API already reports:
 * login state, availability, active cooldowns and the recent success/failure window.
 * React-free so tests/accountHealth.test.ts can consume it directly.
 */

import { isReloginRequired } from '@/features/authFiles/constants';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import type { AuthFileItem } from '@/types';

export type HealthLevel = 'healthy' | 'degraded' | 'critical' | 'off';

export type HealthReason =
  | 'relogin'
  | 'unavailable'
  | 'cooldown'
  | 'model_cooldown'
  | 'failures'
  | 'low_traffic_failures';

export interface AccountHealth {
  file: AuthFileItem;
  /** null while the account is deliberately disabled: it is not scored. */
  score: number | null;
  level: HealthLevel;
  reasons: HealthReason[];
  /** Failure share of the recent window, or null when there is too little traffic. */
  failureRate: number | null;
}

/** Below this many requests the recent window is too thin to judge by rate. */
const MIN_REQUESTS_FOR_RATE = 5;
const HEALTHY_FROM = 85;
const DEGRADED_FROM = 60;

export const levelForScore = (score: number): HealthLevel =>
  score >= HEALTHY_FROM ? 'healthy' : score >= DEGRADED_FROM ? 'degraded' : 'critical';

const recentTotals = (file: AuthFileItem) => {
  const buckets = file.recentRequests ?? file.recent_requests ?? [];
  let success = 0;
  let failed = 0;
  if (Array.isArray(buckets)) {
    for (const bucket of buckets) {
      success += Number(bucket?.success) || 0;
      failed += Number(bucket?.failed) || 0;
    }
  }
  return { success, failed, total: success + failed };
};

export function computeAccountHealth(file: AuthFileItem, nowMs: number): AccountHealth {
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : '';
  if (file.disabled === true || status === 'disabled') {
    return { file, score: null, level: 'off', reasons: [], failureRate: null };
  }

  if (isReloginRequired(file)) {
    return { file, score: 0, level: 'critical', reasons: ['relogin'], failureRate: null };
  }

  const reasons: HealthReason[] = [];
  let score = 100;
  let cap = 100;

  if (file.unavailable === true || status === 'error') {
    reasons.push('unavailable');
    cap = Math.min(cap, 10);
  }

  const cooldowns = file.cooldownSnapshot?.records
    ? summarizeCooldowns(file.cooldownSnapshot, nowMs)
    : null;
  if (cooldowns?.credentialWide) {
    reasons.push('cooldown');
    cap = Math.min(cap, 50);
  } else if (cooldowns && cooldowns.modelCount > 0) {
    // A single model on cooldown leaves the account usable for everything else.
    reasons.push('model_cooldown');
    score -= Math.min(15, cooldowns.modelCount * 5);
  }

  const { failed, total } = recentTotals(file);
  let failureRate: number | null = null;
  if (total >= MIN_REQUESTS_FOR_RATE) {
    failureRate = failed / total;
    if (failureRate >= 0.1) reasons.push('failures');
    score -= Math.round(failureRate * 60);
  } else if (failed > 0 && failed === total) {
    // Every one of a handful of requests failed: worth flagging, too little to rate.
    reasons.push('low_traffic_failures');
    score -= 30;
  }

  score = Math.max(0, Math.min(score, cap));
  return { file, score, level: levelForScore(score), reasons, failureRate };
}

export interface FleetHealth {
  accounts: AccountHealth[];
  /** Mean score across scored accounts; null when none are scored. */
  average: number | null;
  counts: Record<HealthLevel, number>;
}

/** Worst accounts first, so the list leads with what needs attention. */
export function summarizeFleetHealth(files: AuthFileItem[], nowMs: number): FleetHealth {
  const accounts = files.map((file) => computeAccountHealth(file, nowMs));
  const counts: Record<HealthLevel, number> = { healthy: 0, degraded: 0, critical: 0, off: 0 };
  let sum = 0;
  let scored = 0;
  for (const account of accounts) {
    counts[account.level] += 1;
    if (account.score !== null) {
      sum += account.score;
      scored += 1;
    }
  }
  accounts.sort(
    (a, b) =>
      (a.score ?? 101) - (b.score ?? 101) || (a.file.name ?? '').localeCompare(b.file.name ?? '')
  );
  return { accounts, average: scored ? Math.round(sum / scored) : null, counts };
}

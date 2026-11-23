import { describe, expect, test } from 'bun:test';
import { computeAccountHealth, summarizeFleetHealth } from '../src/features/health/accountHealth';
import type { AuthFileItem } from '../src/types';

const NOW = 1_000_000;
const file = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'a.json',
  type: 'claude',
  status: 'active',
  ...overrides,
});
const traffic = (success: number, failed: number) => [{ success, failed }];
const cooldown = (scope: 'model' | 'credential', remainingSeconds: number): AuthFileItem['cooldownSnapshot'] => ({
  receivedAtMs: NOW,
  records: [{ scope, remainingSeconds, reason: 'quota' } as never],
});

describe('computeAccountHealth', () => {
  test('a quiet active account is fully healthy', () => {
    const h = computeAccountHealth(file(), NOW);
    expect(h).toMatchObject({ score: 100, level: 'healthy', reasons: [] });
  });

  test('disabled accounts are not scored', () => {
    const h = computeAccountHealth(file({ disabled: true, status: 'disabled' }), NOW);
    expect(h).toMatchObject({ score: null, level: 'off' });
  });

  test('a rejected login scores zero and says relogin', () => {
    const h = computeAccountHealth(
      file({ status: 'error', unavailable: true, statusMessage: 'unauthorized (refresh token invalid)' }),
      NOW
    );
    expect(h).toMatchObject({ score: 0, level: 'critical', reasons: ['relogin'] });
  });

  test('other errors are capped low but are not a relogin', () => {
    const h = computeAccountHealth(
      file({ status: 'error', unavailable: true, statusMessage: 'model not supported' }),
      NOW
    );
    expect(h.reasons).toEqual(['unavailable']);
    expect(h.score).toBeLessThanOrEqual(10);
  });

  test('failure rate lowers the score and is reported once it is meaningful', () => {
    const h = computeAccountHealth(file({ recentRequests: traffic(70, 30) }), NOW);
    expect(h.failureRate).toBeCloseTo(0.3);
    expect(h.score).toBe(82);
    expect(h.level).toBe('degraded');
    expect(h.reasons).toEqual(['failures']);
  });

  test('a few failures in a busy window do not raise a flag', () => {
    const h = computeAccountHealth(file({ recentRequests: traffic(98, 2) }), NOW);
    expect(h.reasons).toEqual([]);
    expect(h.level).toBe('healthy');
  });

  test('too little traffic is not rated by percentage, except when everything failed', () => {
    expect(computeAccountHealth(file({ recentRequests: traffic(2, 1) }), NOW).failureRate).toBeNull();
    const allFailed = computeAccountHealth(file({ recentRequests: traffic(0, 2) }), NOW);
    expect(allFailed.reasons).toEqual(['low_traffic_failures']);
    expect(allFailed.score).toBe(70);
  });

  test('a credential-wide cooldown caps the score; a model cooldown barely matters', () => {
    const wide = computeAccountHealth(file({ cooldownSnapshot: cooldown('credential', 600) }), NOW);
    expect(wide.score).toBe(50);
    expect(wide.reasons).toEqual(['cooldown']);
    const model = computeAccountHealth(file({ cooldownSnapshot: cooldown('model', 600) }), NOW);
    expect(model.score).toBe(95);
    expect(model.level).toBe('healthy');
    expect(model.reasons).toEqual(['model_cooldown']);
  });

  test('an expired cooldown is ignored', () => {
    const h = computeAccountHealth(file({ cooldownSnapshot: cooldown('credential', 30) }), NOW + 60_000);
    expect(h.reasons).toEqual([]);
    expect(h.score).toBe(100);
  });
});

describe('quota in the score', () => {
  test('exhausted quota caps the score and says so', () => {
    const h = computeAccountHealth(file(), NOW, 0);
    expect(h).toMatchObject({ score: 40, level: 'critical', reasons: ['quota_exhausted'], quotaRemaining: 0 });
  });

  test('low quota costs ten points but stays healthy enough to serve', () => {
    const h = computeAccountHealth(file(), NOW, 15);
    expect(h).toMatchObject({ score: 90, level: 'healthy', reasons: ['quota_low'] });
  });

  test('plenty of quota or unknown quota changes nothing', () => {
    expect(computeAccountHealth(file(), NOW, 80).score).toBe(100);
    expect(computeAccountHealth(file(), NOW, null).score).toBe(100);
  });

  test('quota never rescues an account that is already failing', () => {
    expect(computeAccountHealth(file({ status: 'error', unavailable: true, statusMessage: 'x' }), NOW, 100).score).toBeLessThanOrEqual(10);
  });

  test('fleet summary looks quota up by auth file name', () => {
    const fleet = summarizeFleetHealth([file({ name: 'a.json' }), file({ name: 'b.json' })], NOW, new Map([['b.json', 1]]));
    expect(fleet.accounts.map((a) => [a.file.name, a.score])).toEqual([['b.json', 40], ['a.json', 100]]);
  });
});

describe('summarizeFleetHealth', () => {
  test('orders worst first, leaves disabled last, and averages scored accounts only', () => {
    const fleet = summarizeFleetHealth(
      [
        file({ name: 'ok.json' }),
        file({ name: 'off.json', disabled: true, status: 'disabled' }),
        file({ name: 'dead.json', status: 'error', unavailable: true, statusMessage: 'invalid_grant' }),
        file({ name: 'meh.json', recentRequests: traffic(50, 50) }),
      ],
      NOW
    );
    expect(fleet.accounts.map((a) => a.file.name)).toEqual(['dead.json', 'meh.json', 'ok.json', 'off.json']);
    expect(fleet.counts).toEqual({ healthy: 1, degraded: 1, critical: 1, off: 1 });
    expect(fleet.average).toBe(Math.round((0 + 70 + 100) / 3));
  });

  test('has no average when nothing is scored', () => {
    expect(summarizeFleetHealth([], NOW).average).toBeNull();
  });
});

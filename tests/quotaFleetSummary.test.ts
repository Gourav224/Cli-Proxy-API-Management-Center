import { describe, expect, test } from 'bun:test';
import {
  buildQuotaDisplayNameMap,
  summarizeQuotaFleet,
} from '@/features/quota/quotaFleetSummary';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaCardState } from '@/features/quota/providers';

describe('quotaFleetSummary', () => {
  test('buildQuotaDisplayNameMap prefers email/projectId and disambiguates duplicate accounts safely without reading file.account', () => {
    const entries: QuotaFileEntry[] = [
      {
        type: 'claude',
        file: {
          name: 'claude-c81bdbe6-ops@example.com.json',
          email: 'ops@example.com',
          account: 'sk-ant-secret-should-never-surface',
        },
      },
      {
        type: 'codex',
        file: {
          name: 'codex-team@example.com-plus.json',
          email: 'team@example.com',
        },
      },
      {
        type: 'codex',
        file: {
          name: 'codex-team@example.com-pro.json',
          email: 'team@example.com',
        },
      },
      {
        type: 'antigravity',
        file: {
          name: 'antigravity-plain-credential.json',
          account: 'ya29.secret-token',
        },
      },
    ];

    const map = buildQuotaDisplayNameMap(entries);
    expect(map.get('claude-c81bdbe6-ops@example.com.json')).toBe('ops@example.com');
    expect(map.get('codex-team@example.com-plus.json')).toBe('team@example.com (plus)');
    expect(map.get('codex-team@example.com-pro.json')).toBe('team@example.com (pro)');
    expect(map.get('antigravity-plain-credential.json')).toBe('antigravity-plain-credential');
  });

  test('summarizeQuotaFleet classifies healthy, low, exhausted, error accounts and finds earliest reset', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    const entries: QuotaFileEntry[] = [
      { type: 'claude', file: { name: 'c1.json', email: 'healthy@example.com' } },
      { type: 'claude', file: { name: 'c2.json', email: 'exhausted@example.com' } },
      { type: 'codex', file: { name: 'x1.json', email: 'low@example.com' } },
      { type: 'codex', file: { name: 'x2.json', email: 'err@example.com' } },
    ];

    const quotaMap: Record<string, QuotaCardState> = {
      'c1.json': {
        status: 'success',
        windows: [
          {
            id: 'five-hour',
            label: '5h',
            usedPercent: 25,
            periodHours: 5,
            resetAtMs: Date.parse('2026-11-05T13:00:00Z'),
          },
        ],
      } as unknown as QuotaCardState,
      'c2.json': {
        status: 'success',
        windows: [
          {
            id: 'five-hour',
            label: '5h',
            usedPercent: 100,
            periodHours: 5,
            resetAtMs: Date.parse('2026-11-05T11:15:00Z'),
          },
        ],
      } as unknown as QuotaCardState,
      'x1.json': {
        status: 'success',
        windows: [
          {
            id: 'five-hour',
            label: '5h',
            usedPercent: 88,
            periodHours: 5,
            resetAtMs: Date.parse('2026-11-05T10:45:00Z'),
          },
        ],
      } as unknown as QuotaCardState,
      'x2.json': {
        status: 'error',
        error: 'Upstream 429',
      } as unknown as QuotaCardState,
    };

    const names = buildQuotaDisplayNameMap(entries);
    const summary = summarizeQuotaFleet(
      entries,
      (entry) => quotaMap[entry.file.name],
      (name) => names.get(name) ?? name,
      now
    );

    expect(summary.total).toBe(4);
    expect(summary.loaded).toBe(3);
    expect(summary.healthy).toBe(1);
    expect(summary.low).toBe(1);
    expect(summary.exhausted).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.attentionCount).toBe(3);
    expect(summary.soonestReset?.displayName).toBe('low@example.com');
  });
});

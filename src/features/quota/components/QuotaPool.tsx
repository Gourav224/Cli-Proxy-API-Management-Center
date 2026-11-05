/**
 * Pooled quota chart: each provider's credentials summed into one capacity,
 * with recorded history behind "now" and a projection ahead of it.
 *
 * All maths lives in quotaPoolModel.ts and persistence in quotaPoolHistory.ts —
 * this file is layout only. The chart is a plain SVG: no chart library, no
 * timers beyond the shared minute clock, and readings are recorded only when
 * quota data is actually loaded.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { getTypeLabel } from '@/features/authFiles/constants';
import { TYPE_COLORS, formatRelativeInstant } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { ResolvedTheme } from '@/types';
import { buildTimelineLane } from '../quotaTimelineModel';
import {
  burnRatePerHour,
  projectPool,
  toPoolLanes,
  type PoolLane,
  type PoolMode,
  type PoolResetEvent,
  type PoolSample,
} from '../quotaPoolModel';
import { poolSeriesKey, readPoolSeries, recordPoolSample } from '../quotaPoolHistory';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import styles from './QuotaPool.module.scss';

const POOL_MODES: PoolMode[] = ['weekly', 'session'];
const BURN_WINDOWS = [1, 3, 6] as const;
type BurnWindow = (typeof BURN_WINDOWS)[number];

/** How far back and ahead each mode draws, and how finely it projects. */
const SPAN: Record<PoolMode, { pastMs: number; futureMs: number; stepMs: number }> = {
  weekly: { pastMs: 3 * DAY_MS, futureMs: 10 * DAY_MS, stepMs: HOUR_MS / 2 },
  session: { pastMs: 12 * HOUR_MS, futureMs: 36 * HOUR_MS, stepMs: HOUR_MS / 12 },
};

const VIEW_W = 1000;
const VIEW_H = 200;
/** Reset labels closer than this (in % of width) to the previous one are skipped. */
const LABEL_MIN_GAP_PERCENT = 3.5;

const formatPercent = (value: number) => `${Math.round(value)}%`;

export interface QuotaPoolProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (name: string) => string;
  resolvedTheme: ResolvedTheme;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
  /** Injectable history for tests/screenshots; defaults to browser storage. */
  historyFor?: (key: string) => PoolSample[];
}

interface ProviderPool {
  provider: QuotaProviderType;
  lanes: Record<PoolMode, PoolLane[]>;
}

export function QuotaPool({
  entries,
  quotaFor,
  displayNameFor,
  resolvedTheme,
  now: nowProp,
  historyFor,
}: QuotaPoolProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PoolMode>('weekly');
  const [burnWindow, setBurnWindow] = useState<BurnWindow>(3);
  // Bumped after each recorded reading so the chart re-reads storage.
  const [historyVersion, setHistoryVersion] = useState(0);

  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;

  const pools = useMemo<ProviderPool[]>(() => {
    const byProvider = new Map<QuotaProviderType, QuotaFileEntry[]>();
    entries.forEach((entry) => {
      if (entry.file.disabled) return;
      const list = byProvider.get(entry.type) ?? [];
      list.push(entry);
      byProvider.set(entry.type, list);
    });

    const out: ProviderPool[] = [];
    byProvider.forEach((list, provider) => {
      const lanesFor = (poolMode: PoolMode) =>
        toPoolLanes(
          list.map((entry) =>
            buildTimelineLane({
              name: getQuotaCacheKey(entry.file),
              displayName:
                entry.type === 'devin'
                  ? getQuotaDisplayName(entry.file)
                  : displayNameFor(entry.file.name),
              provider: entry.type,
              quota: quotaFor(entry),
              maxPeriodHours: poolMode === 'session' ? 5 : 7 * 24,
            })
          ),
          poolMode
        );
      const lanes = { weekly: lanesFor('weekly'), session: lanesFor('session') };
      if (lanes.weekly.length > 0 || lanes.session.length > 0) out.push({ provider, lanes });
    });
    return out;
  }, [entries, quotaFor, displayNameFor]);

  // Record one reading per provider and mode whenever loaded quota changes.
  // Keyed on the summed values so re-renders without new data write nothing.
  const readingSignature = pools
    .map((pool) =>
      POOL_MODES.map((poolMode) => {
        const lanes = pool.lanes[poolMode];
        const sum = lanes.reduce((total, lane) => total + lane.remaining, 0);
        return `${pool.provider}:${poolMode}:${lanes.length}:${sum.toFixed(2)}`;
      }).join('|')
    )
    .join('|');

  useEffect(() => {
    if (historyFor || !readingSignature) return;
    const at = Date.now();
    pools.forEach((pool) => {
      POOL_MODES.forEach((poolMode) => {
        const lanes = pool.lanes[poolMode];
        if (lanes.length === 0) return;
        recordPoolSample(poolSeriesKey(pool.provider, poolMode), {
          t: at,
          v: lanes.reduce((total, lane) => total + lane.remaining, 0),
          c: lanes.length * 100,
        });
      });
    });
    setHistoryVersion((value) => value + 1);
    // `pools` is fully described by the signature; depending on it directly
    // would record on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readingSignature, historyFor]);

  const visible = useMemo(
    () => pools.filter((pool) => pool.lanes[mode].length > 0),
    [pools, mode]
  );
  // Read storage once per recorded reading or mode switch, not per render.
  const histories = useMemo(() => {
    const read = historyFor ?? readPoolSeries;
    return new Map(
      visible.map((pool) => [pool.provider, read(poolSeriesKey(pool.provider, mode))])
    );
    // historyVersion is the signal that storage changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mode, historyFor, historyVersion]);

  if (pools.length === 0) return null;

  return (
    <section className={styles.pool}>
      <header className={styles.head}>
        <div>
          <h2 className={styles.title}>
            {t('quota_management.pool_title', { defaultValue: 'Pooled quota' })}
          </h2>
          <p className={styles.subtitle}>
            {t('quota_management.pool_subtitle', {
              defaultValue: 'All credentials of a provider summed, recorded and projected.',
            })}
          </p>
        </div>
        <div className={styles.controls}>
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('quota_management.pool_window_label', { defaultValue: 'Quota window' })}
          >
            {POOL_MODES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {value === 'weekly'
                  ? t('quota_management.windows_mode_weekly', { defaultValue: 'Weekly' })
                  : t('quota_management.windows_mode_session', { defaultValue: '5-hour' })}
              </button>
            ))}
          </div>
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('quota_management.pool_burn_window_label', {
              defaultValue: 'Burn rate window',
            })}
          >
            {BURN_WINDOWS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={burnWindow === value}
                onClick={() => setBurnWindow(value)}
              >
                {t('quota_management.pool_hours', { defaultValue: '{{count}}h', count: value })}
              </button>
            ))}
          </div>
        </div>
      </header>

      {visible.length === 0 ? (
        <div className={styles.empty} role="status">
          {t('quota_management.pool_empty', {
            defaultValue: 'No loaded credentials report this quota window yet.',
          })}
        </div>
      ) : (
        <div className={styles.cards} data-count={visible.length}>
          {visible.map((pool) => (
            <PoolCard
              key={pool.provider}
              provider={pool.provider}
              lanes={pool.lanes[mode]}
              mode={mode}
              burnWindow={burnWindow}
              now={now}
              resolvedTheme={resolvedTheme}
              history={histories.get(pool.provider) ?? []}
            />
          ))}
        </div>
      )}

      <p className={styles.note}>
        {t('quota_management.pool_note', {
          defaultValue:
            'History is kept in this browser only and recorded when quota is loaded. Projection assumes the selected burn rate is spread evenly across credentials.',
        })}
      </p>
    </section>
  );
}

interface PoolCardProps {
  provider: QuotaProviderType;
  lanes: PoolLane[];
  mode: PoolMode;
  burnWindow: BurnWindow;
  now: number;
  resolvedTheme: ResolvedTheme;
  history: PoolSample[];
}

function PoolCard({
  provider,
  lanes,
  mode,
  burnWindow,
  now,
  resolvedTheme,
  history,
}: PoolCardProps) {
  const { t, i18n } = useTranslation();
  const span = SPAN[mode];
  const startMs = now - span.pastMs;
  const endMs = now + span.futureMs;
  const capacity = lanes.length * 100;

  const burn = useMemo(
    () => burnRatePerHour(history, now, burnWindow),
    [history, now, burnWindow]
  );
  const projection = useMemo(
    () => projectPool(lanes, now, endMs, burn, span.stepMs),
    [lanes, now, endMs, burn, span.stepMs]
  );

  const x = (ms: number) => ((ms - startMs) / (endMs - startMs)) * VIEW_W;
  const y = (value: number) => VIEW_H - (Math.max(0, value) / capacity) * VIEW_H;

  const recorded = useMemo(() => {
    const points = history
      .filter((sample) => sample.c === capacity && sample.t >= startMs && sample.t < now)
      .map((sample) => ({ t: sample.t, v: sample.v }));
    points.push({ t: now, v: projection.remaining });
    return points;
  }, [history, capacity, startMs, now, projection.remaining]);

  const toPath = (points: { t: number; v: number }[]) =>
    points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ');
  const recordedPath = recorded.length > 1 ? toPath(recorded) : '';
  const recordedArea = recordedPath
    ? `${recordedPath} L${x(now).toFixed(1)},${VIEW_H} L${x(recorded[0].t).toFixed(1)},${VIEW_H} Z`
    : '';
  const projectedPath = toPath(projection.points);
  const nowX = (x(now) / VIEW_W) * 100;

  const resetLabels = useMemo(() => {
    type Label = PoolResetEvent & { left: number; top: number };
    return projection.resets.reduce<Label[]>((labels, reset) => {
      if (reset.gain < 1) return labels;
      const left = ((reset.t - startMs) / (endMs - startMs)) * 100;
      const previous = labels[labels.length - 1];
      if (previous && left - previous.left < LABEL_MIN_GAP_PERCENT) return labels;
      labels.push({ ...reset, left, top: 100 - (reset.level / capacity) * 100 });
      return labels;
    }, []);
  }, [projection, startMs, endMs, capacity]);

  const ticks = useMemo(() => {
    const out: { left: number; label: string }[] = [];
    const stepMs = mode === 'weekly' ? DAY_MS : 6 * HOUR_MS;
    const first = new Date(startMs);
    if (mode === 'weekly') first.setHours(24, 0, 0, 0);
    else first.setHours(Math.ceil((first.getHours() + 1) / 6) * 6, 0, 0, 0);
    for (let at = first.getTime(); at < endMs; at += stepMs) {
      const date = new Date(at);
      out.push({
        left: ((at - startMs) / (endMs - startMs)) * 100,
        label:
          mode === 'weekly'
            ? date.toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric' })
            : date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }),
      });
    }
    return out;
  }, [mode, startMs, endMs, i18n.language]);

  const color = TYPE_COLORS[provider]?.[resolvedTheme]?.text ?? 'var(--text-secondary)';
  const formatAt = (ms: number) =>
    new Date(ms).toLocaleString(i18n.language, {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  const notWithin = t('quota_management.pool_not_by', {
    defaultValue: 'Not by {{date}}',
    date: new Date(endMs).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' }),
  });

  const stats: { label: string; value: string }[] = [
    {
      label: t('quota_management.pool_stat_pool_empty', { defaultValue: 'Pool empty' }),
      value: projection.poolEmptyMs === null ? notWithin : formatAt(projection.poolEmptyMs),
    },
    {
      label: t('quota_management.pool_stat_first_empty', { defaultValue: 'First empty' }),
      value: projection.firstEmpty
        ? `${projection.firstEmpty.displayName} ${formatRelativeInstant(projection.firstEmpty.t, now, i18n.language)}`
        : notWithin,
    },
    {
      label: t('quota_management.pool_stat_next_reset', { defaultValue: 'Next reset' }),
      value: projection.nextReset
        ? `+${formatPercent(projection.nextReset.gain)} ${formatAt(projection.nextReset.t)}`
        : '—',
    },
    {
      label: t('quota_management.pool_stat_burn', {
        defaultValue: 'Burn, last {{count}}h',
        count: burnWindow,
      }),
      value:
        burn === null
          ? t('quota_management.pool_burn_collecting', { defaultValue: 'collecting…' })
          : `${burn.toFixed(1)}%/h`,
    },
  ];

  return (
    <article className={styles.card} style={{ '--pool-color': color } as CSSProperties}>
      <header className={styles.cardHead}>
        <div>
          <div className={styles.provider}>
            <span className={styles.providerName}>{getTypeLabel(t, provider)}</span>
            <span className={styles.accounts}>
              {t('quota_management.pool_accounts', {
                defaultValue: '{{count}} accounts',
                count: lanes.length,
              })}
            </span>
          </div>
          <div className={styles.total}>
            <span className={styles.totalValue}>{formatPercent(projection.remaining)}</span>
            <span className={styles.totalOf}>
              {t('quota_management.pool_of', {
                defaultValue: 'of {{capacity}}',
                capacity: formatPercent(capacity),
              })}
            </span>
          </div>
        </div>
        <dl className={styles.stats}>
          {stats.map((stat) => (
            <div key={stat.label} className={styles.stat}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          <span>{formatPercent(capacity)}</span>
          <span>{formatPercent(capacity / 2)}</span>
          <span>0%</span>
        </div>
        <div className={styles.canvas}>
          <svg
            className={styles.svg}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t('quota_management.pool_chart_label', {
              defaultValue: '{{provider}} pooled quota over time',
              provider: getTypeLabel(t, provider),
            })}
          >
            <line className={styles.gridLine} x1="0" x2={VIEW_W} y1={VIEW_H / 2} y2={VIEW_H / 2} />
            {recordedArea && <path className={styles.area} d={recordedArea} />}
            {recordedPath && <path className={styles.recorded} d={recordedPath} />}
            <path className={styles.projected} d={projectedPath} />
            <line className={styles.nowLine} x1={x(now)} x2={x(now)} y1="0" y2={VIEW_H} />
          </svg>
          <span className={styles.nowLabel} style={{ left: `${nowX}%` }}>
            {t('quota_management.pool_now', { defaultValue: 'Now' })}
          </span>
          {resetLabels.map((label) => (
            <span
              key={`${label.name}:${label.t}`}
              className={styles.resetLabel}
              style={{ left: `${label.left}%`, top: `${label.top}%` }}
              title={`${label.displayName} · ${formatAt(label.t)}`}
            >
              +{formatPercent(label.gain)}
            </span>
          ))}
          <div className={styles.xAxis} aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick.left} style={{ left: `${tick.left}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <footer className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.swatchRecorded} />
          {t('quota_management.pool_legend_recorded', { defaultValue: 'Recorded' })}
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchProjected} />
          {t('quota_management.pool_legend_projected', { defaultValue: 'Projected' })}
        </span>
      </footer>
    </article>
  );
}

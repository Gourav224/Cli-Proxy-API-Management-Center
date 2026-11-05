import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import {
  setLiveRefreshInterval,
  useLiveRefreshSnapshot,
} from '@/stores/useLiveRefreshStore';
import {
  LIVE_REFRESH_INTERVALS,
  parseLiveRefreshInterval,
  type LiveRefreshInterval,
} from '@/utils/liveRefreshScheduler';
import { MINUTE_CLOCK, SECOND_CLOCK } from '@/utils/time/sharedClock';
import styles from './LiveRefreshControl.module.scss';

const noopSubscribe = () => () => {};
const FROZEN_NOW = Date.now();
const getFrozenNow = () => FROZEN_NOW;

interface LiveRefreshControlProps {
  disabled?: boolean;
  isLogsRoute?: boolean;
  onManualRefresh: () => void;
}

const INTERVAL_LABEL_KEY: Record<string, string> = {
  off: 'header.live_off',
  '5000': 'header.live_5s',
  '10000': 'header.live_10s',
  '30000': 'header.live_30s',
  '60000': 'header.live_1m',
};

export function LiveRefreshControl({
  disabled = false,
  isLogsRoute = false,
  onManualRefresh,
}: LiveRefreshControlProps) {
  const { t } = useTranslation();
  const {
    interval,
    isRefreshing,
    lastUpdatedAt,
    consecutiveErrors,
    autoRefreshEnabled,
    hidden,
  } = useLiveRefreshSnapshot();

  const shouldObserveClock = !hidden && lastUpdatedAt !== null;
  const minuteNow = useSyncExternalStore(
    shouldObserveClock ? MINUTE_CLOCK.subscribe : noopSubscribe,
    shouldObserveClock ? MINUTE_CLOCK.getSnapshot : getFrozenNow,
    getFrozenNow
  );

  // Only subscribe to 1s clock while visible and timestamp is within ~65s of minute snapshot.
  const shouldTickSeconds =
    shouldObserveClock && lastUpdatedAt !== null && minuteNow - lastUpdatedAt < 65_000;

  const secondNow = useSyncExternalStore(
    shouldTickSeconds ? SECOND_CLOCK.subscribe : noopSubscribe,
    shouldTickSeconds ? SECOND_CLOCK.getSnapshot : getFrozenNow,
    getFrozenNow
  );

  const now = shouldTickSeconds ? secondNow : shouldObserveClock ? minuteNow : FROZEN_NOW;

  const updatedLabel = (() => {
    if (isLogsRoute) {
      return t('header.live_stream');
    }
    if (consecutiveErrors > 0) {
      return t('header.live_backoff');
    }
    if (lastUpdatedAt === null) {
      return interval === 'off' ? t('header.live_off') : t('header.live_label');
    }
    const elapsedSec = Math.max(0, Math.floor((now - lastUpdatedAt) / 1000));
    if (elapsedSec < 3) {
      return t('header.updated_just_now');
    }
    if (elapsedSec < 60) {
      return t('header.updated_seconds_ago', { count: elapsedSec });
    }
    const elapsedMin = Math.max(1, Math.floor(elapsedSec / 60));
    return t('header.updated_minutes_ago', { count: elapsedMin });
  })();

  const dotClass = (() => {
    if (disabled || interval === 'off') return styles.dotOff;
    if (consecutiveErrors > 0) return styles.dotWarning;
    if (isLogsRoute || autoRefreshEnabled) return styles.dotLive;
    return styles.dotOff;
  })();

  const handleSelectInterval = (next: LiveRefreshInterval) => {
    setLiveRefreshInterval(next);
  };

  return (
    <div className={styles.control} role="group" aria-label={t('header.live_label')}>
      <span className={styles.statusReadout} aria-live="off">
        <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
        <span className={styles.updatedText}>{updatedLabel}</span>
      </span>

      <div className={styles.segmented} role="group" aria-label={t('header.live_label')}>
        {LIVE_REFRESH_INTERVALS.map((opt) => {
          const label = t(INTERVAL_LABEL_KEY[String(opt)]);
          const active = interval === opt;
          return (
            <button
              key={String(opt)}
              type="button"
              className={styles.segmentBtn}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => handleSelectInterval(opt)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className={styles.compactSelectWrap}>
        <select
          className={styles.compactSelect}
          aria-label={t('header.live_label')}
          value={String(interval)}
          disabled={disabled}
          onChange={(e) => handleSelectInterval(parseLiveRefreshInterval(e.target.value))}
        >
          {LIVE_REFRESH_INTERVALS.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {t(INTERVAL_LABEL_KEY[String(opt)])}
            </option>
          ))}
        </select>
        <span className={styles.compactChevron} aria-hidden="true">
          ▾
        </span>
      </div>

      <button
        type="button"
        className={styles.refreshBtn}
        onClick={onManualRefresh}
        disabled={disabled}
        title={t('header.refresh_now')}
        aria-label={t('header.refresh_now')}
      >
        <IconRefreshCw size={15} className={isRefreshing ? styles.spinning : undefined} />
      </button>
    </div>
  );
}

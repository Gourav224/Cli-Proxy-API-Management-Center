import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import {
  summarizeFleetHealth,
  type AccountHealth,
  type HealthLevel,
  type HealthReason,
} from '@/features/health/accountHealth';
import type { AuthFileItem } from '@/types';
import { Meter } from './Meter';
import type { MeterTone } from '../utils';
import styles from './AccountHealthPanel.module.scss';

const MAX_ROWS = 6;

const TONE_FOR_LEVEL: Record<HealthLevel, MeterTone> = {
  healthy: 'good',
  degraded: 'warning',
  critical: 'critical',
  off: 'idle',
};

interface AccountHealthPanelProps {
  files: AuthFileItem[] | null;
  nowMs: number;
  /** Lowest remaining quota percentage per auth file name, for accounts whose quota is loaded. */
  quotaRemainingByName?: ReadonlyMap<string, number | null>;
}

export function AccountHealthPanel({
  files,
  nowMs,
  quotaRemainingByName,
}: AccountHealthPanelProps) {
  const { t } = useTranslation();
  const fleet = useMemo(
    () => (files ? summarizeFleetHealth(files, nowMs, quotaRemainingByName) : null),
    [files, nowMs, quotaRemainingByName]
  );

  if (!fleet || fleet.accounts.length === 0) return null;

  const scored = fleet.accounts.filter((account) => account.level !== 'off');
  const attention = scored.filter((account) => account.level !== 'healthy');
  const rows = attention.slice(0, MAX_ROWS);
  const hidden = attention.length - rows.length;

  const reasonLabel = (account: AccountHealth, reason: HealthReason) =>
    reason === 'failures'
      ? t('dashboard.health_reason_failures', {
          percent: Math.round((account.failureRate ?? 0) * 100),
        })
      : reason === 'quota_low'
        ? t('dashboard.health_reason_quota_low', {
            percent: Math.round(account.quotaRemaining ?? 0),
          })
        : t(`dashboard.health_reason_${reason}`);

  return (
    <section className={styles.panel} aria-label={t('dashboard.health_title')}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h2 className={styles.title}>{t('dashboard.health_title')}</h2>
          <p className={styles.subtitle}>
            {t('dashboard.health_subtitle', {
              score: fleet.average ?? '–',
              healthy: fleet.counts.healthy,
              degraded: fleet.counts.degraded,
              critical: fleet.counts.critical,
            })}
          </p>
        </div>
        <Link to="/auth-files" className={styles.link}>
          {t('dashboard.health_open_accounts')}
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className={styles.allGood}>{t('dashboard.health_all_good', { count: scored.length })}</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((account) => {
            const identity = deriveAuthFileIdentity(account.file);
            const name = identity.primary || account.file.name;
            const score = account.score ?? 0;
            return (
              <li key={account.file.name} className={styles.row}>
                <span
                  className={`${styles.score} ${styles[`score_${account.level}`]}`}
                  aria-label={t('dashboard.health_score_aria', {
                    score,
                    level: t(`dashboard.health_level_${account.level}`),
                  })}
                >
                  {score}
                </span>
                <div className={styles.identity}>
                  <span className={styles.name} title={name}>
                    {name}
                  </span>
                  <span className={styles.provider}>
                    {getTypeLabel(t, String(account.file.type ?? account.file.provider ?? ''))}
                  </span>
                </div>
                <div className={styles.reasons}>
                  {account.reasons.map((reason) => (
                    <span key={reason} className={styles.reason}>
                      {reasonLabel(account, reason)}
                    </span>
                  ))}
                </div>
                <Meter
                  value={score}
                  tone={TONE_FOR_LEVEL[account.level]}
                  ariaLabel={name}
                  className={styles.meter}
                />
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 ? (
        <p className={styles.more}>{t('dashboard.health_more', { count: hidden })}</p>
      ) : null}
    </section>
  );
}

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useLiveRefreshSnapshot } from '@/stores';
import styles from './QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  totalCount: number;
  loadedCount: number;
  attentionCount: number;
  refreshing: boolean;
  disableControls: boolean;
  onRefreshAll: () => void;
};

export function QuotaHeader(props: QuotaHeaderProps) {
  const {
    totalCount,
    loadedCount,
    attentionCount,
    refreshing,
    disableControls,
    onRefreshAll,
  } = props;
  const { t } = useTranslation();
  const { interval } = useLiveRefreshSnapshot();

  return (
    <header className={styles.header}>
      <div className={styles.topRow}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('quota_management.title')}
          </h1>
          <p className={styles.description} data-reveal>
            {t('quota_management.description')}
          </p>
        </div>
        <div className={styles.actions} data-reveal>
          <button
            type="button"
            className={styles.primaryAction}
            onClick={onRefreshAll}
            disabled={disableControls || refreshing}
          >
            <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
            {t('quota_management.refresh_all_credentials')}
          </button>
        </div>
      </div>

      <div className={styles.kpiStrip} data-reveal>
        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>{t('quota_management.stat_active_accounts')}</span>
          <div className={styles.kpiValueRow}>
            <strong className={styles.kpiValue}>{totalCount}</strong>
          </div>
        </div>

        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>{t('quota_management.stat_loaded')}</span>
          <div className={styles.kpiValueRow}>
            <strong className={`${styles.kpiValue} ${loadedCount > 0 ? styles.kpiValueGood : ''}`}>
              {loadedCount}
            </strong>
            <span className={styles.kpiSub}>/ {totalCount}</span>
          </div>
        </div>

        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>{t('quota_management.stat_attention')}</span>
          <div className={styles.kpiValueRow}>
            <strong
              className={`${styles.kpiValue} ${attentionCount > 0 ? styles.kpiValueWarn : ''}`}
            >
              {attentionCount}
            </strong>
          </div>
        </div>

        <div className={styles.kpiCard}>
          <span className={styles.kpiLabel}>{t('quota_management.stat_cadence')}</span>
          <div className={styles.kpiValueRow}>
            <strong className={styles.kpiValue}>
              {interval === 'off'
                ? t('quota_management.cadence_paused')
                : t('quota_management.cadence_active')}
            </strong>
          </div>
        </div>
      </div>
    </header>
  );
}

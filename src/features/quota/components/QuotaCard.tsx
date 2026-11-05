import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useQuotaStore } from '@/stores';
import type { ClaudeQuotaState, ResolvedTheme } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { bindQuotaClasses } from '../types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { hasClaudeUsageData } from '../providers/claude/data';
import bodyStyles from './QuotaBody.module.scss';
import styles from './QuotaCard.module.scss';

const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

export type QuotaCardProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  entranceDelayMs?: number | null;
  onRefresh: () => void;
  onReset: () => void;
};

export function QuotaCard(props: QuotaCardProps) {
  const {
    entry,
    quota,
    resolvedTheme,
    canRefresh,
    resetting,
    entranceDelayMs,
    onRefresh,
    onReset,
  } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const cacheKey = getQuotaCacheKey(file);
  const isBackgroundRefreshing = useQuotaStore((state) => Boolean(state.quotaRefreshing[cacheKey]));

  const retainedClaudeUsage =
    entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);

  const identity = deriveAuthFileIdentity(file);
  const fallbackName = getQuotaDisplayName(file);
  const primaryLabel = identity.primary || fallbackName;

  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const entranceStyle =
    mountEntranceDelayMs === null
      ? undefined
      : ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties);

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const busyRefreshing = loading || isBackgroundRefreshing;

  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || busyRefreshing || resetting,
    quota,
    onRefresh
  );
  const providerType =
    entry.type === 'plugin'
      ? String(
          file.quotaProvider ?? file['quota_provider'] ?? file.provider ?? file.type ?? 'plugin'
        )
      : entry.type;
  const iconSrc = getAuthFileIcon(providerType, resolvedTheme);
  const typeLabel = getTypeLabel(t, providerType);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );

  const showClaudeReset = entry.type === 'claude' && status === 'success';
  const claudePlanItems = showClaudeReset ? (
    <span className={quotaClasses.codexPlanItem}>
      <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
      <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
    </span>
  ) : undefined;
  const claudeAfterPlan = showClaudeReset ? (
    <>
      <ClaudeResetGrantDetails grants={claudeReset.grants} classes={quotaClasses} />
      {claudeReset.message && (
        <div role="status" className={quotaClasses.codexResetCreditsError}>
          {t(`claude_reset.${claudeReset.message}`)}
        </div>
      )}
    </>
  ) : undefined;
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <article
      className={`${styles.card} ${mountEntranceDelayMs === null ? '' : styles.cardEnter}`}
      style={entranceStyle}
    >
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          title={typeLabel}
          style={
            isThemeSurfaceIconProvider(providerType)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>

        <div className={styles.identity}>
          <div className={styles.primaryRow}>
            <span
              className={`${styles.primaryName} ${
                identity.kind === 'fileName' ? styles.primaryMono : ''
              }`}
              title={identity.fullName}
            >
              {primaryLabel}
            </span>
            <span className={styles.providerBadge}>{typeLabel}</span>
          </div>
          {identity.secondary ? (
            <span className={styles.secondaryName} title={identity.fullName}>
              {identity.secondary}
            </span>
          ) : null}
        </div>
      </header>

      <div className={styles.body}>
        {(status === 'idle' || loading) && !retainedClaudeUsage ? (
          <div className={styles.skeleton} role="status" aria-busy="true">
            <span className={styles.srOnly}>{t('quota_management.loading_auto')}</span>
            {[0, 1].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.errorStrip} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : quota && !retainedClaudeUsage ? (
          <adapter.Body
            quota={quota}
            classes={quotaClasses}
            planItems={claudePlanItems}
            afterPlan={claudeAfterPlan}
          />
        ) : null}
        {retainedClaudeUsage && quota && (
          <adapter.Body
            quota={quota}
            classes={quotaClasses}
            planItems={claudePlanItems}
            afterPlan={claudeAfterPlan}
          />
        )}
      </div>

      <footer className={styles.actionRow}>
        {entry.type === 'claude' && status === 'success' && (
          <button
            type="button"
            className={styles.actionPill}
            disabled={claudeReset.blocked}
            onClick={claudeReset.confirm}
            title={t(`claude_reset.${claudeReset.buttonLabel}`)}
          >
            <IconRefreshCw size={13} className={claudeReset.busy ? styles.spinning : undefined} />
            {t(`claude_reset.${claudeReset.buttonLabel}`)}
          </button>
        )}
        {showReset && (
          <button
            type="button"
            className={styles.actionPill}
            onClick={onReset}
            disabled={!canRefresh || busyRefreshing || resetting}
            title={t('codex_quota.reset_button')}
          >
            <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
            {t('codex_quota.reset_button')}
          </button>
        )}
        <button
          type="button"
          className={styles.actionPill}
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(
            canRefresh,
            busyRefreshing,
            resetting || claudeReset.busy
          )}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw size={13} className={busyRefreshing ? styles.spinning : undefined} />
          {t('auth_files.quota_refresh_single')}
        </button>
      </footer>
    </article>
  );
}

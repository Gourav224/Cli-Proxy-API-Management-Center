import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconBot,
  IconFileText,
  IconSidebarConfig,
  IconSidebarLogs,
  IconSidebarQuota,
  IconSidebarSystem,
} from '@/components/ui/icons';
import { useAuthStore, useQuotaStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { formatCompactNumber, formatDateValue, formatPercent } from '@/utils/format';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getTypeLabel, isReloginRequired } from '@/features/authFiles/constants';
import { classifyQuotaFiles, type QuotaFileEntry } from '@/features/quota/logic';
import { buildQuotaDisplayNameMap, summarizeQuotaFleet } from '@/features/quota/quotaFleetSummary';
import { useQuotaAutoRefresh } from '@/features/quota/hooks/useQuotaAutoRefresh';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { providerIdOfAuthFile, useDashboardOverview } from './hooks/useDashboardOverview';
import { Meter } from './components/Meter';
import { Sparkline } from './components/Sparkline';
import { ThroughputChart } from './components/ThroughputChart';
import { providerLabel, splitWindowMinutes, toneForSuccessRate, type MeterTone } from './utils';
import styles from './dashboard.module.scss';

const DASH = '—';

const formatHeadline = (value: number): string =>
  value < 100_000 ? value.toLocaleString() : formatCompactNumber(value);

const formatRelativeCountdown = (targetMs: number, nowMs: number): string => {
  const diffMin = Math.max(1, Math.round((targetMs - nowMs) / 60_000));
  if (diffMin < 60) return `${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (hours < 48) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
};

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);
  const now = useNow(true);

  const {
    connectionStatus,
    connected,
    config,
    counts,
    traffic,
    providers,
    authFiles,
    credentials,
    refresh,
  } = useDashboardOverview();

  useHeaderRefresh(refresh, connected);

  const reloginFiles = useMemo(
    () => (authFiles ?? []).filter(isReloginRequired),
    [authFiles]
  );
  const reloginSummary = useMemo(() => {
    const byType = new Map<string, number>();
    reloginFiles.forEach((file) => {
      const label = getTypeLabel(t, providerIdOfAuthFile(file));
      byType.set(label, (byType.get(label) ?? 0) + 1);
    });
    return Array.from(byType.entries())
      .map(([label, count]) => `${label} ×${count}`)
      .join(', ');
  }, [reloginFiles, t]);

  /* Live quota store integration so the operator sees pooled quota health at a glance on / */
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const quotaEntries = useMemo(() => classifyQuotaFiles(authFiles ?? []), [authFiles]);
  const quotaNames = useMemo(() => buildQuotaDisplayNameMap(quotaEntries), [quotaEntries]);
  const displayNameFor = useCallback(
    (name: string) => quotaNames.get(name) ?? name,
    [quotaNames]
  );
  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  useQuotaAutoRefresh(quotaEntries, connected && quotaEntries.length > 0);

  const quotaFleet = useMemo(
    () => summarizeQuotaFleet(quotaEntries, getQuota, displayNameFor, now),
    [displayNameFor, getQuota, now, quotaEntries]
  );

  const windowLabel = useMemo(() => {
    if (traffic.windowMinutes <= 0) return DASH;
    const { hours, minutes } = splitWindowMinutes(traffic.windowMinutes);
    if (hours === 0) return t('dashboard.window_m', { minutes });
    if (minutes === 0) return t('dashboard.window_h', { hours });
    return t('dashboard.window_hm', { hours, minutes });
  }, [traffic.windowMinutes, t]);

  const routingStrategy = useMemo(() => {
    const raw = config?.routingStrategy?.trim() ?? '';
    if (!raw) return DASH;
    if (raw === 'round-robin') return t('basic_settings.routing_strategy_round_robin');
    if (raw === 'weighted-round-robin') {
      return t('basic_settings.routing_strategy_weighted_round_robin');
    }
    if (raw === 'fill-first') return t('basic_settings.routing_strategy_fill_first');
    return raw;
  }, [config?.routingStrategy, t]);

  const unknownProviderLabel = t('dashboard.provider_unknown');
  const successRateTone: MeterTone = toneForSuccessRate(traffic.successRate);

  const statusBadge = useMemo(() => {
    if (!connected) {
      return {
        label:
          connectionStatus === 'connecting'
            ? t('common.connecting')
            : t('common.disconnected'),
        tone: 'warn' as const,
      };
    }
    if (quotaFleet.exhausted > 0 || reloginFiles.length > 0 || successRateTone === 'critical') {
      return { label: t('dashboard.hero_verdict_warning'), tone: 'warn' as const };
    }
    return { label: t('dashboard.hero_verdict_good'), tone: 'good' as const };
  }, [connected, connectionStatus, quotaFleet.exhausted, reloginFiles.length, successRateTone, t]);

  const runtimeRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('dashboard.runtime_routing'), value: routingStrategy },
    { label: t('dashboard.runtime_retry'), value: String(config?.requestRetry ?? 0) },
    {
      label: t('dashboard.runtime_management_keys'),
      value: counts.managementKeys === null ? DASH : String(counts.managementKeys),
    },
    { label: t('dashboard.runtime_version'), value: serverVersion?.trim() || DASH, mono: true },
    {
      label: t('dashboard.runtime_build'),
      value: formatDateValue(serverBuildDate, i18n.language) || DASH,
    },
    { label: t('dashboard.runtime_proxy'), value: config?.proxyUrl?.trim() || DASH, mono: true },
  ];

  const runtimeToggles = config
    ? [
        { label: t('dashboard.runtime_debug'), on: Boolean(config.debug) },
        { label: t('dashboard.runtime_file_logging'), on: Boolean(config.loggingToFile) },
        { label: t('dashboard.runtime_request_log'), on: Boolean(config.requestLog) },
        { label: t('dashboard.runtime_ws_auth'), on: Boolean(config.wsAuth) },
        { label: t('dashboard.runtime_model_prefix'), on: Boolean(config.forceModelPrefix) },
      ]
    : [];

  const ctaCards = [
    {
      to: '/quota',
      icon: <IconSidebarQuota size={18} />,
      title: t('nav.quota_management'),
    },
    {
      to: '/auth-files',
      icon: <IconFileText size={18} />,
      title: t('nav.auth_files'),
      description: t('dashboard.cta_auth_files_desc'),
    },
    {
      to: '/ai-providers',
      icon: <IconBot size={18} />,
      title: t('nav.ai_providers'),
      description: t('dashboard.cta_providers_desc'),
    },
    {
      to: '/logs',
      icon: <IconSidebarLogs size={18} />,
      title: t('nav.logs'),
    },
    {
      to: '/config',
      icon: <IconSidebarConfig size={18} />,
      title: t('nav.config_management'),
      description: t('dashboard.cta_config_desc'),
    },
    {
      to: '/system',
      icon: <IconSidebarSystem size={18} />,
      title: t('nav.system_info'),
    },
  ];

  return (
    <div className={styles.page}>
      {/* Compact Operator Header */}
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.titleRow}>
            <h1 className={styles.pageTitle}>{t('nav.dashboard')}</h1>
            <span
              className={`${styles.statusPill} ${
                statusBadge.tone === 'good' ? styles.statusGood : styles.statusWarn
              }`}
            >
              <span className={styles.statusDot} aria-hidden="true" />
              {statusBadge.label}
            </span>
          </div>
          {traffic.total === 0 && connected ? (
            <p className={styles.subtitle}>{t('dashboard.idle_traffic_note')}</p>
          ) : null}
        </div>

        <div className={styles.headerActions}>
          <Link to="/quota" className={styles.primaryAction}>
            {t('dashboard.quota_open_link')}
          </Link>
          <Link to="/ai-providers" className={styles.secondaryAction}>
            {t('dashboard.cta_manage_providers')}
          </Link>
          <Link to="/logs" className={styles.secondaryAction}>
            {t('dashboard.cta_inspect_logs')}
          </Link>
        </div>
      </header>

      {reloginFiles.length > 0 ? (
        <section className={styles.reloginBanner} role="alert">
          <div className={styles.reloginCopy}>
            <strong>{t('dashboard.relogin_title', { count: reloginFiles.length })}</strong>
            <span>
              {reloginSummary} · {t('dashboard.relogin_body')}
            </span>
          </div>
          <Link to="/auth-files" className={styles.reloginAction}>
            {t('dashboard.relogin_action')}
          </Link>
        </section>
      ) : null}

      {/* 4-up High-Density Operator KPI Strip */}
      <section className={styles.kpiGrid} aria-label={t('dashboard.stats_aria')}>
        <article className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>{t('dashboard.hero_requests_label')}</span>
            <span className={styles.kpiBadge}>{windowLabel}</span>
          </div>
          <strong className={styles.kpiValue}>
            {connected ? formatHeadline(traffic.total) : DASH}
          </strong>
          <div className={styles.kpiFootSplit}>
            <span className={styles.kpiGoodText}>
              {t('stats.success')}: <b>{traffic.totalSuccess.toLocaleString()}</b>
            </span>
            <span className={traffic.totalFailure > 0 ? styles.kpiWarnText : styles.kpiMutedText}>
              {t('stats.failure')}: <b>{traffic.totalFailure.toLocaleString()}</b>
            </span>
          </div>
        </article>

        <article className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>{t('dashboard.success_rate')}</span>
          </div>
          <strong className={styles.kpiValue}>
            {traffic.successRate === null ? DASH : formatPercent(traffic.successRate)}
          </strong>
          {traffic.successRate !== null ? (
            <Meter
              value={traffic.successRate}
              tone={successRateTone}
              ariaLabel={t('dashboard.success_rate')}
              className={styles.kpiMeter}
            />
          ) : null}
          <span className={styles.kpiHint}>
            {t('dashboard.stat_success_hint', { total: traffic.total.toLocaleString() })}
          </span>
        </article>

        <article className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>{t('dashboard.stat_credentials')}</span>
            {quotaFleet.exhausted > 0 ? (
              <span className={styles.kpiAlertBadge}>
                {quotaFleet.exhausted} {t('dashboard.quota_exhausted')}
              </span>
            ) : null}
          </div>
          <strong className={styles.kpiValue}>
            {credentials ? `${credentials.active} / ${credentials.total}` : DASH}
          </strong>
          <span className={styles.kpiHint}>
            {credentials
              ? t('dashboard.stat_credentials_hint', {
                  active: credentials.active,
                  disabled: credentials.disabled + credentials.unavailable,
                })
              : t('dashboard.stat_credentials_empty')}
          </span>
        </article>

        <article className={styles.kpiCard}>
          <div className={styles.kpiHead}>
            <span className={styles.kpiLabel}>{t('dashboard.stat_models')}</span>
            <span className={styles.kpiBadge}>{routingStrategy}</span>
          </div>
          <strong className={styles.kpiValue}>
            {counts.models === null ? DASH : counts.models.toLocaleString()}
          </strong>
          <span className={styles.kpiHint}>
            {t('dashboard.stat_provider_keys')}:{' '}
            <b>{counts.providerKeys === null ? DASH : counts.providerKeys.toLocaleString()}</b>
          </span>
        </article>
      </section>

      {/* Primary Focal Grid: Throughput Timeline + Live Credential Quota Pool Health */}
      <section className={styles.mainSplit}>
        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>{t('dashboard.traffic_title')}</h2>
              <p className={styles.panelSubtitle}>
                {t('dashboard.traffic_description', { window: windowLabel })}
              </p>
            </div>
          </header>
          <ThroughputChart traffic={traffic} />
        </article>

        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>{t('dashboard.quota_pool_title')}</h2>
              <p className={styles.panelSubtitle}>{t('dashboard.quota_pool_subtitle')}</p>
            </div>
            <Link to="/quota" className={styles.panelLink}>
              {t('dashboard.quota_open_link')} →
            </Link>
          </header>

          {quotaFleet.total === 0 ? (
            <p className={styles.emptyNote}>{t('quota_management.empty_desc')}</p>
          ) : (
            <div className={styles.quotaSummaryBody}>
              <div className={styles.quotaPillsRow}>
                <div className={styles.quotaStatBox}>
                  <span className={styles.quotaStatLabel}>{t('dashboard.quota_healthy')}</span>
                  <strong className={`${styles.quotaStatNum} ${styles.textSuccess}`}>
                    {quotaFleet.loaded === 0 ? '…' : quotaFleet.healthy}
                  </strong>
                </div>
                <div className={styles.quotaStatBox}>
                  <span className={styles.quotaStatLabel}>{t('dashboard.quota_low')}</span>
                  <strong
                    className={`${styles.quotaStatNum} ${
                      quotaFleet.low > 0 ? styles.textAmber : ''
                    }`}
                  >
                    {quotaFleet.loaded === 0 ? '…' : quotaFleet.low}
                  </strong>
                </div>
                <div className={styles.quotaStatBox}>
                  <span className={styles.quotaStatLabel}>{t('dashboard.quota_exhausted')}</span>
                  <strong
                    className={`${styles.quotaStatNum} ${
                      quotaFleet.exhausted > 0 ? styles.textDanger : ''
                    }`}
                  >
                    {quotaFleet.loaded === 0 ? '…' : quotaFleet.exhausted}
                  </strong>
                </div>
              </div>

              <ul className={styles.providerPoolList}>
                {quotaFleet.byProvider.map((item) => {
                  const pct = item.averageRemainingPercent;
                  const label = getTypeLabel(t, item.provider);
                  return (
                    <li key={item.provider} className={styles.providerPoolRow}>
                      <div className={styles.providerPoolTop}>
                        <span className={styles.providerPoolName}>{label}</span>
                        <span className={styles.providerPoolMeta}>
                          {item.loadedAccounts}/{item.totalAccounts} ·{' '}
                          <b>{pct === null ? t('dashboard.quota_sampling') : formatPercent(pct)}</b>
                        </span>
                      </div>
                      <div className={styles.providerPoolTrack} aria-hidden="true">
                        <span
                          className={`${styles.providerPoolFill} ${
                            pct !== null && pct < 20 ? styles.fillWarn : ''
                          }`}
                          style={{ width: `${pct !== null ? Math.max(2, pct) : 0}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>

              {quotaFleet.soonestReset ? (
                <div className={styles.nextResetStrip}>
                  <span className={styles.nextResetLabel}>{t('dashboard.quota_next_reset')}</span>
                  <span className={styles.nextResetValue}>
                    {quotaFleet.soonestReset.displayName} ·{' '}
                    <b>{formatRelativeCountdown(quotaFleet.soonestReset.atMs, now)}</b>
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </article>
      </section>

      {/* Secondary Grid: Provider Traffic Fleet + Runtime Configuration */}
      <section className={styles.detailGrid}>
        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>{t('dashboard.fleet_title')}</h2>
              <p className={styles.panelSubtitle}>{t('dashboard.fleet_description')}</p>
            </div>
          </header>
          {providers.length === 0 ? (
            <div className={styles.fleetFallback}>
              <p className={styles.emptyNote}>{t('dashboard.fleet_empty')}</p>
              {credentials && credentials.byType.length > 0 ? (
                <ul className={styles.typeList}>
                  {credentials.byType.map((entry) => (
                    <li key={entry.type} className={styles.typeChip}>
                      <span>{providerLabel(entry.type, unknownProviderLabel)}</span>
                      <b>{entry.count.toLocaleString()}</b>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <ul className={styles.fleetList}>
              {providers.map((provider, index) => (
                <li key={provider.id} className={styles.fleetRow}>
                  <span className={styles.fleetRank} aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className={styles.fleetIdentity}>
                    <span className={styles.fleetName}>
                      {providerLabel(provider.id, unknownProviderLabel)}
                    </span>
                    <span className={styles.fleetMeta}>
                      {t('dashboard.fleet_credentials', { value: provider.credentials })}
                    </span>
                  </div>
                  <Sparkline
                    points={provider.buckets.map((bucket) => bucket.success + bucket.failed)}
                    ariaLabel={t('dashboard.fleet_spark_label', {
                      provider: providerLabel(provider.id, unknownProviderLabel),
                    })}
                    className={styles.fleetSpark}
                  />
                  <div className={styles.fleetNumbers}>
                    <span className={styles.fleetTotal}>{provider.total.toLocaleString()}</span>
                    <span className={styles.fleetTotalLabel}>{t('dashboard.fleet_requests')}</span>
                  </div>
                  <div className={styles.fleetRate}>
                    <span className={styles.fleetRateValue}>
                      {provider.successRate === null ? DASH : formatPercent(provider.successRate)}
                    </span>
                    <Meter
                      value={provider.successRate}
                      ariaLabel={t('dashboard.success_rate')}
                      className={styles.fleetMeter}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div>
              <h2 className={styles.panelTitle}>{t('dashboard.runtime_title')}</h2>
              <p className={styles.panelSubtitle}>{t('dashboard.runtime_eyebrow')}</p>
            </div>
          </header>
          <dl className={styles.runtimeList}>
            {runtimeRows.map((row) => (
              <div key={row.label} className={styles.runtimeRow}>
                <dt>{row.label}</dt>
                <dd className={row.mono ? styles.mono : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {runtimeToggles.length > 0 && (
            <ul className={styles.toggleRow}>
              {runtimeToggles.map((toggle) => (
                <li
                  key={toggle.label}
                  className={`${styles.togglePill} ${
                    toggle.on ? styles.toggleOn : styles.toggleOff
                  }`}
                >
                  <i className={styles.toggleDot} aria-hidden="true" />
                  <span>{toggle.label}</span>
                  <b>{toggle.on ? t('dashboard.flag_on') : t('dashboard.flag_off')}</b>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      {/* Compact Operator Quick Links */}
      <section className={styles.ctaGrid} aria-label={t('dashboard.cta_title')}>
        {ctaCards.map((card) => (
          <Link key={card.to} to={card.to} className={styles.ctaCard}>
            <span className={styles.ctaIcon} aria-hidden="true">
              {card.icon}
            </span>
            <div className={styles.ctaCopy}>
              <h3 className={styles.ctaTitle}>{card.title}</h3>
              <p className={styles.ctaDescription}>{card.description}</p>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}

import { useCallback, useEffect, useRef } from 'react';
import { liveRefreshScheduler } from '@/stores/useLiveRefreshStore';
export type { RefreshContext as HeaderRefreshContext } from '@/utils/liveRefreshScheduler';
import type { RefreshContext } from '@/utils/liveRefreshScheduler';

export type HeaderRefreshHandler = (context?: RefreshContext) => void | Promise<void>;

export type HeaderRefreshOptions =
  | boolean
  | {
      enabled?: boolean;
      autoRefresh?: boolean;
    };

let activeHeaderRefreshHandler: HeaderRefreshHandler | null = null;

export const triggerHeaderRefresh = async (context: RefreshContext = { source: 'manual' }) => {
  if (!activeHeaderRefreshHandler) return;
  await activeHeaderRefreshHandler(context);
};

export const useHeaderRefresh = (
  handler?: HeaderRefreshHandler | null,
  optionsOrEnabled: HeaderRefreshOptions = true
) => {
  const enabled =
    typeof optionsOrEnabled === 'boolean'
      ? optionsOrEnabled
      : (optionsOrEnabled.enabled ?? true);
  const autoRefresh =
    typeof optionsOrEnabled === 'boolean'
      ? true
      : (optionsOrEnabled.autoRefresh ?? true);

  const latestHandlerRef = useRef<HeaderRefreshHandler | null>(handler ?? null);
  const hasHandler = Boolean(handler);

  useEffect(() => {
    latestHandlerRef.current = handler ?? null;
  }, [handler]);

  const wrapper = useCallback<HeaderRefreshHandler>(
    (ctx) => latestHandlerRef.current?.(ctx),
    []
  );

  useEffect(() => {
    if (!enabled || !hasHandler) {
      if (activeHeaderRefreshHandler === wrapper) {
        activeHeaderRefreshHandler = null;
        liveRefreshScheduler.setHandler(null, { enabled: false, autoRefresh: false });
      }
      return;
    }

    activeHeaderRefreshHandler = wrapper;
    liveRefreshScheduler.setHandler(wrapper, { enabled: true, autoRefresh });

    return () => {
      if (activeHeaderRefreshHandler === wrapper) {
        activeHeaderRefreshHandler = null;
        liveRefreshScheduler.setHandler(null, { enabled: false, autoRefresh: false });
      }
    };
  }, [autoRefresh, enabled, hasHandler, wrapper]);
};

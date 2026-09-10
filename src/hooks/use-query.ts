"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api";

interface QueryState<T> {
  data: T | null;
  error: string | null;
  /** True while the first response for the current URL is loading. */
  loading: boolean;
  /** True while a request is refreshing already-rendered data. */
  refreshing: boolean;
  refresh: () => void;
  setData: (data: T | null) => void;
}

/**
 * Small GET-query hook with stale-while-revalidate semantics. A refresh never
 * removes the data that is already on screen, so a background request cannot
 * replace an interactive dashboard with a page-sized loading blocker.
 */
export function useQuery<T>(url: string | null, options: { refreshIntervalMs?: number } = {}): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;

    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiFetch<T>(url, { signal: controller.signal });
        if (cancelled) return;
        setData(result);
      } catch (fetchError) {
        if (cancelled || controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : "The request could not be completed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, nonce]);

  useEffect(() => {
    if (!options.refreshIntervalMs || !url) return;
    const timer = setInterval(() => setNonce((value) => value + 1), options.refreshIntervalMs);
    return () => clearInterval(timer);
  }, [url, options.refreshIntervalMs]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  // A null URL disables the query; stale state is masked rather than reset.
  return {
    data: url ? data : null,
    error: url ? error : null,
    loading: url ? loading : false,
    refreshing: Boolean(url && loading && data),
    refresh,
    setData,
  };
}

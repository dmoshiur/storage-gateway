"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api";

interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  setData: (data: T | null) => void;
}

/** Minimal GET-query hook with refresh. Session expiry is handled globally. */
export function useQuery<T>(url: string | null, options: { refreshIntervalMs?: number } = {}): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    // Deferred so state updates never run synchronously inside the effect.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      apiFetch<T>(url)
        .then((result) => {
          if (cancelled) return;
          setData(result);
          setError(null);
        })
        .catch((fetchError: Error) => {
          if (cancelled) return;
          setError(fetchError.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => { cancelled = true; };
  }, [url, nonce]);

  useEffect(() => {
    if (!options.refreshIntervalMs || !url) return;
    const timer = setInterval(() => setNonce((value) => value + 1), options.refreshIntervalMs);
    return () => clearInterval(timer);
  }, [url, options.refreshIntervalMs]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  // A null URL disables the query; stale state is masked rather than reset.
  return { data: url ? data : null, error: url ? error : null, loading: url ? loading : false, refresh, setData };
}

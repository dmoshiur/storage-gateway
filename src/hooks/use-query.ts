"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, ClientApiError } from "@/lib/client/api";

/** Everything the UI needs to explain a failure without hiding its real cause. */
export interface QueryErrorInfo {
  message: string;
  code: string;
  requestId: string | null;
  /** Underlying dependency message reported by the API (`error.details.cause`). */
  cause: string | null;
  causeCode: string | null;
  hint: string | null;
  retryable: boolean;
}

interface QueryState<T> {
  data: T | null;
  error: string | null;
  errorInfo: QueryErrorInfo | null;
  /** True while the first response for the current URL is loading. */
  loading: boolean;
  /** True while a request is refreshing already-rendered data. */
  refreshing: boolean;
  refresh: () => void;
  setData: (data: T | null) => void;
}

function describeError(error: unknown): QueryErrorInfo {
  if (error instanceof ClientApiError) {
    const details = error.details ?? {};
    const text = (key: string): string | null => {
      const value = details[key];
      return typeof value === "string" && value ? value : null;
    };
    return {
      message: error.message,
      code: error.code,
      requestId: error.requestId,
      cause: text("cause"),
      causeCode: text("causeCode"),
      hint: text("hint"),
      retryable: details.retryable === true,
    };
  }
  return {
    message: error instanceof Error ? error.message : "The request could not be completed.",
    code: "REQUEST_FAILED",
    requestId: null,
    cause: null,
    causeCode: null,
    hint: null,
    retryable: true,
  };
}

/**
 * Small GET-query hook with stale-while-revalidate semantics. A refresh never
 * removes the data that is already on screen, so a background request cannot
 * replace an interactive dashboard with a page-sized loading blocker.
 */
export function useQuery<T>(url: string | null, options: { refreshIntervalMs?: number } = {}): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [errorInfo, setErrorInfo] = useState<QueryErrorInfo | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;

    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      setLoading(true);
      setErrorInfo(null);
      try {
        const result = await apiFetch<T>(url, { signal: controller.signal });
        if (cancelled) return;
        setData(result);
      } catch (fetchError) {
        if (cancelled || controller.signal.aborted) return;
        // Keep the full structured failure (code, requestId, real cause) so the
        // UI can show why the request failed instead of a generic message.
        setErrorInfo(describeError(fetchError));
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
  // Every page that renders `error` shows the real cause, not just the generic
  // summary line the API returns.
  const error = errorInfo
    ? errorInfo.cause && errorInfo.cause !== errorInfo.message
      ? `${errorInfo.message} — ${errorInfo.cause}`
      : errorInfo.message
    : null;
  // A null URL disables the query; stale state is masked rather than reset.
  return {
    data: url ? data : null,
    error: url ? error : null,
    errorInfo: url ? errorInfo : null,
    loading: url ? loading : false,
    refreshing: Boolean(url && loading && data),
    refresh,
    setData,
  };
}

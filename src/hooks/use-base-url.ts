"use client";

import { useEffect, useState } from "react";

/**
 * Returns the current deployment origin (e.g. `https://cloud.example.org`),
 * resolved from the browser after mount so the value always matches the actual
 * production domain — never a hard-coded placeholder. Empty until hydrated.
 */
export function useBaseUrl(): string {
  const [baseUrl, setBaseUrl] = useState("");
  useEffect(() => {
    // Deferred so the state update never runs synchronously inside the effect.
    const timer = window.setTimeout(() => {
      setBaseUrl(window.location.origin.replace(/\/+$/, ""));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return baseUrl;
}

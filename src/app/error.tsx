"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

/**
 * Global segment error boundary. Catches render errors in any route that does
 * not define its own, more specific boundary. The interface stays interactive:
 * the user can retry the failed route without losing navigation.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Route error", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-14 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-red-500/10 text-red-500">
        <TriangleAlert className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-[15px] font-semibold text-ink">Something went wrong</h1>
      <p className="mt-1 max-w-sm text-sm leading-6 text-ink-muted">
        The page could not be rendered. The service may be temporarily unavailable.
      </p>
      {error.digest && <p className="mt-2 font-mono text-[11px] text-ink-faint">Error ID: {error.digest}</p>}
      <button type="button" className="btn-primary mt-5" onClick={() => reset()}>
        <RotateCw className="h-4 w-4" /> Try again
      </button>
    </div>
  );
}

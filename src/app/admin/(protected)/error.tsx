"use client";

import { useEffect } from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

/**
 * Dashboard error boundary. Because this lives *inside* the protected layout,
 * the sidebar, header and navigation stay fully functional when a page throws —
 * the user can navigate away or retry without ever being trapped.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Dashboard route error", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-red-500/10 text-red-500">
        <TriangleAlert className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-[15px] font-semibold text-ink">Unable to load this page</h1>
      <p className="mt-1 max-w-sm text-sm leading-6 text-ink-muted">
        Something interrupted this view. You can keep using the navigation, or retry loading the page.
      </p>
      {error.digest && <p className="mt-2 font-mono text-[11px] text-ink-faint">Error ID: {error.digest}</p>}
      <button type="button" className="btn-primary mt-5" onClick={() => reset()}>
        <RotateCw className="h-4 w-4" /> Try again
      </button>
    </div>
  );
}

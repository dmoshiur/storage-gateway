"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

/**
 * Root error boundary. Renders when a fatal error escapes the root layout —
 * the app can no longer rely on its shell, so we render a minimal, branded
 * fallback with a hard reload. This is the last line of defense; it must never
 * itself throw.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Uncaught application error", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b1220", color: "#e2e8f0", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ display: "grid", minHeight: "100vh", placeItems: "center", padding: "1.5rem" }}>
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <div style={{ display: "inline-grid", width: 48, height: 48, placeItems: "center", borderRadius: 12, background: "rgba(239,68,68,0.15)", color: "#f87171" }}>
              <TriangleAlert size={24} />
            </div>
            <h1 style={{ marginTop: 16, fontSize: 18, fontWeight: 600 }}>Something went wrong</h1>
            <p style={{ marginTop: 8, fontSize: 14, lineHeight: 1.6, color: "#94a3b8" }}>
              The application hit an unexpected error. Reloading usually resolves it.
            </p>
            {error.digest && (
              <p style={{ marginTop: 8, fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#64748b" }}>
                Error ID: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                marginTop: 20,
                padding: "10px 16px",
                borderRadius: 8,
                border: 0,
                background: "#e2e8f0",
                color: "#0f172a",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Reload application
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}

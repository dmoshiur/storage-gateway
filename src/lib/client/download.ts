"use client";

import { ClientApiError } from "@/lib/client/api";

/**
 * Client-side helpers for the authenticated streaming routes.
 *
 * `/api/files/:id/preview?stream=true` and `/api/files/:id/download?stream=true`
 * return the private PDF bytes through our own API route (session cookie
 * auth + role authorization + PostgreSQL lookup), so the browser never receives
 * a Vercel Blob URL — not a permanent one and not even a short-lived signed
 * one. These helpers turn that response into a Blob / a saved file while
 * keeping the same public error envelope as `apiFetch`.
 */

interface StreamErrorEnvelope {
  success?: boolean;
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
  requestId?: string;
}

/** GETs an authenticated route that streams private file bytes. */
export async function fetchStreamedFile(path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ClientApiError("NETWORK_ERROR", "Network connection failed. Check your connection and try again.");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as StreamErrorEnvelope | null;
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("gateway-session-expired"));
    }
    throw new ClientApiError(
      payload?.error?.code ?? "FILE_STREAM_FAILED",
      payload?.error?.message ?? "The document could not be retrieved.",
      {
        status: response.status,
        requestId: payload?.error?.requestId ?? payload?.requestId ?? null,
      },
    );
  }

  return response.blob();
}

/** Saves a Blob under `filename` and revokes the temporary object URL. */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

"use client";

export class ClientApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly fields?: Record<string, string>;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number | null;
      requestId?: string | null;
      fields?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = "ClientApiError";
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.fields = options.fields;
  }
}

/**
 * Normalizes a caught error into a user-facing message and request id for
 * toasts. Server-side dependency diagnostics are never sent to the browser.
 */
export function apiErrorOptions(error: unknown, fallback: string): { message: string; requestId?: string } {
  if (error instanceof ClientApiError) {
    return {
      message: error.message,
      requestId: error.requestId ?? undefined,
    };
  }
  return { message: fallback };
}

interface ErrorEnvelope {
  success?: boolean;
  data?: unknown;
  requestId?: string;
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
    fields?: Record<string, string>;
  };
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    // Aborted requests are normal when a page/filter changes. Let the query
    // hook ignore them instead of turning them into a user-facing error.
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ClientApiError("NETWORK_ERROR", "Network connection failed. Check your connection and try again.");
  }

  let payload: ErrorEnvelope;
  try {
    const body = await response.text();
    payload = JSON.parse(body) as ErrorEnvelope;
  } catch {
    throw new ClientApiError("INVALID_RESPONSE", "The service returned an unexpected response. Please try again.", {
      status: response.status,
    });
  }
  if (!response.ok || !payload.success) {
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("gateway-session-expired"));
    const requestId = payload.error?.requestId ?? payload.requestId ?? null;
    throw new ClientApiError(
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? "The request could not be completed.",
      { status: response.status, requestId, fields: payload.error?.fields },
    );
  }
  return payload.data as T;
}

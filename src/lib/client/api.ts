"use client";

export class ClientApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly fields?: Record<string, string>;
  /** Real backend cause carried by the API: cause, causeCode, hint, retryable. */
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number | null;
      requestId?: string | null;
      fields?: Record<string, string>;
      details?: Record<string, string | number | boolean>;
    } = {},
  ) {
    super(message);
    this.name = "ClientApiError";
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.fields = options.fields;
    this.details = options.details;
  }

  /** The underlying dependency message, when the API reported one. */
  get causeMessage(): string | null {
    const cause = this.details?.cause;
    return typeof cause === "string" && cause ? cause : null;
  }
}

/**
 * Normalizes a caught error into a user-facing message + request id for toasts.
 * The real backend cause is appended when the API reported one, so an operator
 * is never left with only a generic "could not be completed".
 */
export function apiErrorOptions(error: unknown, fallback: string): { message: string; requestId?: string } {
  if (error instanceof ClientApiError) {
    const cause = error.causeMessage;
    return {
      message: cause && cause !== error.message ? `${error.message} — ${cause}` : error.message,
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
    /** Real backend cause: cause, causeCode, hint, retryable, operation. */
    details?: Record<string, string | number | boolean>;
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
      { status: response.status, requestId, fields: payload.error?.fields, details: payload.error?.details },
    );
  }
  return payload.data as T;
}

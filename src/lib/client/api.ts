"use client";

export class ClientApiError extends Error {
  constructor(public code: string, message: string, public fields?: Record<string, string>) {
    super(message);
    this.name = "ClientApiError";
  }
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
  } catch {
    throw new ClientApiError("NETWORK_ERROR", "Network connection failed. Check your connection and try again.");
  }

  let payload: { success?: boolean; data?: T; error?: { code?: string; message?: string; fields?: Record<string, string> } };
  try {
    payload = await response.json();
  } catch {
    throw new ClientApiError("INVALID_RESPONSE", "The service returned an unexpected response. Please try again.");
  }
  if (!response.ok || !payload.success) {
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("gateway-session-expired"));
    throw new ClientApiError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "The request could not be completed.", payload.error?.fields);
  }
  return payload.data as T;
}

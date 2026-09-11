import { ApiError } from "@/lib/api/errors";

/** Bounds a best-effort database operation without hiding the real failure. */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, "DATABASE_TIMEOUT", `Database did not respond within ${timeoutMs} ms (${label}).`, undefined, { timeoutMs, label, retryable: true })), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

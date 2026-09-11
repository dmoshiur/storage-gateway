import { ApiError } from "@/lib/api/errors";

/**
 * Rejects with a `FIRESTORE_TIMEOUT` ApiError if `operation` has not settled
 * within `timeoutMs`.
 *
 * The Firestore Admin SDK retries unreachable endpoints internally, so a hung
 * connection can leave a request pending for minutes. That is acceptable for a
 * user-initiated save (the caller is waiting for the write) but not for
 * best-effort work such as an audit-log entry or a health probe: those must
 * fail fast so the page still renders and the operator can see what is wrong.
 *
 * The timeout does not cancel the underlying operation; it only stops the
 * caller from waiting on it.
 */
export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ApiError(
              504,
              "FIRESTORE_TIMEOUT",
              `Firestore did not respond within ${timeoutMs} ms (${label}).`,
              undefined,
              { timeoutMs, label, retryable: true },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

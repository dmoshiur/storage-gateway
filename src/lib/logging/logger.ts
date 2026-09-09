import "server-only";

const sensitiveKey = /password|secret|token|authorization|cookie|credential|private.?key|signed.?url/i;
const signedUrl = /(?:X-Amz-(?:Credential|Signature|Security-Token)|[?&](?:token|signature)=)/i;

function sanitize(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return signedUrl.test(value) ? "[REDACTED]" : value.slice(0, 1000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey)]));
  }
  return value;
}

/**
 * Structured operational logging. Redacts common secret/token fields as a
 * second line of defense; callers must still avoid logging credentials.
 */
function emit(level: "info" | "warn" | "error", message: string, context: Record<string, unknown> = {}) {
  const safeContext = sanitize(context) as Record<string, unknown>;
  const event = JSON.stringify({ level, message: sanitize(message), at: new Date().toISOString(), ...safeContext });
  if (level === "error") console.error(event);
  else if (level === "warn") console.warn(event);
  else console.info(event);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};

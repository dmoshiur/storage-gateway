import type { z } from "zod";
import { ApiError } from "@/lib/api/errors";

/**
 * Turns Zod issues into a *specific, safe* client-facing failure.
 *
 * Previously every schema rejection collapsed into the single sentence
 * "Some information is missing or invalid." The offending field and reason
 * were attached as `fields`, but no caller rendered them, so a genuine
 * "password too short" surfaced in the Create User modal as an unactionable
 * generic string. This module makes the top-level `message` describe the
 * actual first problem, which is what users and operators read.
 *
 * Zod issues only ever describe the *shape* of the submitted payload (types,
 * lengths, enum membership). They never contain SQL, driver output, stack
 * frames, connection strings or secret material, so promoting them to the
 * response body is safe. Submitted values themselves are never echoed back —
 * in particular a rejected password is never included in the message.
 */

/** Field names rendered with a specific label instead of a naive de-camelCase. */
const FIELD_LABELS: Record<string, string> = {
  body: "Request body",
  query: "Query parameters",
  email: "Email address",
  password: "Password",
  newPassword: "New password",
  currentPassword: "Current password",
  displayName: "Display name",
  role: "Role",
  uid: "User id",
  token: "Token",
};

/** `displayName` → `Display name`; `retention.customDeleteAt` → `Custom delete at`. */
function humanizeFieldName(path: string): string {
  const leaf = path.split(".").pop() ?? path;
  const spaced = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return "Value";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function labelFor(path: string): string {
  return FIELD_LABELS[path] ?? FIELD_LABELS[path.split(".").pop() ?? ""] ?? humanizeFieldName(path);
}

/**
 * True when a message already reads as a complete, user-facing sentence and
 * should be shown verbatim (our schemas supply these).
 */
function isAuthoredSentence(message: string): boolean {
  return /[.!?]$/.test(message.trim()) && /\s/.test(message.trim());
}

/** Rewrites Zod's terse built-in strings into something a person can act on. */
function readableIssueMessage(issue: z.ZodIssue, label: string): string {
  const raw = issue.message?.trim() ?? "";

  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `${label} is required.`;
  }
  if (raw.toLowerCase() === "required") {
    return `${label} is required.`;
  }
  if (isAuthoredSentence(raw)) return raw;

  const normalized = raw
    // "String must contain at least 12 character(s)" → "must be at least 12 characters"
    .replace(/^String must contain at least (\d+) character\(s\)$/i, "must be at least $1 characters")
    .replace(/^String must contain at most (\d+) character\(s\)$/i, "must be $1 characters or fewer")
    .replace(/^Array must contain at most (\d+) element\(s\)$/i, "must contain at most $1 items")
    .replace(/^Array must contain at least (\d+) element\(s\)$/i, "must contain at least $1 items")
    .replace(/^Number must be (.*)$/i, "must be $1")
    .replace(/^Invalid enum value\. Expected (.*?), received .*$/i, "must be one of: $1")
    .replace(/^Invalid email$/i, "is not a valid email address")
    .replace(/^Invalid url$/i, "is not a valid URL")
    .replace(/^Invalid$/i, "is invalid")
    .replace(/^Expected .*, received .*$/i, "has an unexpected format");

  if (normalized === raw && /^[A-Z]/.test(raw)) {
    // An authored fragment without terminal punctuation (e.g. "Use a valid date").
    return raw.endsWith(".") ? raw : `${raw}.`;
  }
  return `${label} ${normalized}.`.replace(/\.\.+$/, ".");
}

/** Maps issues to `{ field: message }` for inline, per-field rendering. */
export function fieldsFromIssues(issues: readonly z.ZodIssue[], fallbackKey = "body"): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path.join(".") || fallbackKey;
    // Keep the first issue per field: it is the most specific failure.
    if (!(path in fields)) fields[path] = readableIssueMessage(issue, labelFor(path));
  }
  return fields;
}

/**
 * Builds the single specific sentence shown to the user.
 *
 * With several bad fields the first is reported and the rest are summarized,
 * so the message stays short while `fields` still carries every detail.
 */
export function validationMessageFrom(issues: readonly z.ZodIssue[], fallbackKey = "body"): string {
  const fields = fieldsFromIssues(issues, fallbackKey);
  const entries = Object.entries(fields);
  if (entries.length === 0) return "The submitted information is invalid.";
  const [, first] = entries[0]!;
  if (entries.length === 1) return first;
  const others = entries.length - 1;
  return `${first} (and ${others} other ${others === 1 ? "problem" : "problems"} with this form)`;
}

/**
 * Creates the `ApiError` for a failed schema parse: a specific top-level
 * message plus the per-field map.
 */
export function validationError(issues: readonly z.ZodIssue[], fallbackKey = "body"): ApiError {
  return new ApiError(
    400,
    "VALIDATION_ERROR",
    validationMessageFrom(issues, fallbackKey),
    fieldsFromIssues(issues, fallbackKey),
  );
}

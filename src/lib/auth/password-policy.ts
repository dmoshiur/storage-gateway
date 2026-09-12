/**
 * Single source of truth for the account password policy.
 *
 * This module is intentionally free of `server-only` and of any Node built-in
 * so the admin UI, the Zod schemas, the API routes and the migration script
 * all describe the *same* rule. Previously the minimum length was written by
 * hand in six places (two Zod schemas, two database helpers, three input
 * `minLength` attributes and the docs), which is how the Create User modal
 * ended up rejecting a password the placeholder text appeared to allow.
 */

/**
 * Minimum characters for any account password.
 *
 * 12 is the policy this deployment already enforces for the bootstrap
 * administrator (`scripts/migrate.mjs`), self-service password changes and
 * password resets, and it is what README/docs document. Admin-created accounts
 * now use the identical rule instead of a stricter, undocumented one.
 */
export const PASSWORD_MIN_LENGTH = 12;

/** Upper bound, purely to stop unbounded hashing work from a single request. */
export const PASSWORD_MAX_LENGTH = 512;

/** Message shown when a supplied password is shorter than the policy. */
export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;

/** Message shown when a supplied password exceeds the accepted length. */
export const PASSWORD_TOO_LONG_MESSAGE = `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`;

/** Short helper text for password inputs. */
export const PASSWORD_POLICY_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`;

export interface PasswordPolicyResult {
  ok: boolean;
  /** Specific, safe, user-facing reason. Never contains the password itself. */
  message: string | null;
}

/**
 * Validates a password against the policy.
 *
 * Returns a reason instead of throwing so callers can decide the transport
 * (Zod issue, ApiError, inline field error). The candidate value is never
 * echoed back in the message.
 */
export function checkPasswordPolicy(password: unknown): PasswordPolicyResult {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, message: "Password is required." };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, message: PASSWORD_TOO_SHORT_MESSAGE };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: PASSWORD_TOO_LONG_MESSAGE };
  }
  return { ok: true, message: null };
}

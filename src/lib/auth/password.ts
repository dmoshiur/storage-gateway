import "server-only";

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password-policy";

/**
 * Password hashing.
 *
 * Algorithm: scrypt — a salted, memory-hard KDF built into Node's crypto
 * module. OWASP's Password Storage Cheat Sheet lists scrypt as the recommended
 * alternative when Argon2id is unavailable, and ranks it above bcrypt (bcrypt
 * is CPU-hard only, and silently truncates input at 72 bytes). Using the Node
 * built-in also avoids a native addon (`argon2`, `bcrypt`) that needs
 * node-gyp at install time and can fail to build in serverless deployments.
 *
 * Parameters: N=2^16, r=8, p=2 — one of the configurations OWASP lists as
 * meeting its minimum strength (equivalent to N=2^17, r=8, p=1, trading memory
 * for parallelism). It costs ~64 MiB and a few hundred milliseconds per hash,
 * which is affordable per login while being expensive to attack offline.
 *
 * The previous parameters (N=2^14, r=8, p=1) were *below* the OWASP minimum.
 * Existing hashes remain valid: every hash records the parameters it was made
 * with, verification honours them, and `needsRehash` reports stored hashes
 * that are weaker than the current policy so they can be upgraded in place on
 * the next successful sign-in.
 */

const SCRYPT_N = 65_536;
const SCRYPT_R = 8;
const SCRYPT_P = 2;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Largest parameters accepted from a stored hash, to bound memory per verify. */
const MAX_ALLOWED_N = 1 << 20;
const MAX_ALLOWED_R = 32;
const MAX_ALLOWED_P = 16;

/**
 * scrypt needs roughly `128 * N * r` bytes; Node rejects the call when that
 * exceeds `maxmem`. Deriving the budget from the parameters (instead of a
 * fixed 128 MiB) keeps both current and future parameter sets working.
 */
function memoryBudget(n: number, r: number, p: number): number {
  return 128 * n * r + 128 * r * p + 1024 * 1024;
}

function derive(password: string, salt: Buffer, keyLength: number, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, keyLength, { N: n, r, p, maxmem: memoryBudget(n, r, p) });
}

/** Password hashes are self-describing so parameters can be upgraded safely. */
export function hashPassword(password: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("A password is required.");
  }
  // Bound the work a single request can trigger. The policy enforces this
  // earlier; this is the last line of defense before the KDF runs.
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error("The password is too long to hash.");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = derive(password, salt, KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  digest: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  if (typeof encoded !== "string") return null;
  const [algorithm, n, r, p, saltEncoded, digestEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltEncoded || !digestEncoded) return null;

  const parsedN = Number(n);
  const parsedR = Number(r);
  const parsedP = Number(p);
  // Reject nonsense parameters rather than handing them to scrypt, where an
  // absurd N from a corrupted row would try to allocate unbounded memory.
  const sane =
    Number.isInteger(parsedN) && parsedN > 1 && parsedN <= MAX_ALLOWED_N && (parsedN & (parsedN - 1)) === 0 &&
    Number.isInteger(parsedR) && parsedR > 0 && parsedR <= MAX_ALLOWED_R &&
    Number.isInteger(parsedP) && parsedP > 0 && parsedP <= MAX_ALLOWED_P;
  if (!sane) return null;

  const salt = Buffer.from(saltEncoded, "base64url");
  const digest = Buffer.from(digestEncoded, "base64url");
  if (salt.length === 0 || digest.length === 0) return null;
  return { n: parsedN, r: parsedR, p: parsedP, salt, digest };
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    if (typeof password !== "string" || password.length === 0) return false;
    if (password.length > PASSWORD_MAX_LENGTH) return false;
    const parsed = parseHash(encoded);
    if (!parsed) return false;
    // Verification uses the parameters recorded in the stored hash, so hashes
    // written under the older, weaker settings still verify correctly.
    const actual = derive(password, parsed.salt, parsed.digest.length, parsed.n, parsed.r, parsed.p);
    return actual.length === parsed.digest.length && timingSafeEqual(actual, parsed.digest);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was produced with weaker settings than the current
 * policy, so callers can transparently re-hash after a successful sign-in.
 */
export function needsRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (!parsed) return true;
  return parsed.n < SCRYPT_N || parsed.r < SCRYPT_R || parsed.n * parsed.r * parsed.p < SCRYPT_N * SCRYPT_R * SCRYPT_P;
}

export function generateTemporaryPassword(): string {
  // 18 random bytes → 24 base64url characters, comfortably above the policy
  // minimum and generated from a CSPRNG.
  return `Tmp-${randomBytes(18).toString("base64url")}`;
}

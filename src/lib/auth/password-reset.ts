import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { query } from "@/lib/db/client";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function issuePasswordResetToken(email: string): Promise<string | null> {
  const user = await query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND disabled = false LIMIT 1`, [email.trim().toLowerCase()]);
  if (!user.rows[0]) return null;
  const token = randomBytes(32).toString("base64url");
  await query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.rows[0].id]);
  await query(`INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [user.rows[0].id, digest(token)]);
  return token;
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  const result = await query<{ id: string; user_id: string }>(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, user_id`,
    [digest(token)],
  );
  return result.rows[0]?.user_id ?? null;
}

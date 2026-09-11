import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { query, SQL_NOW } from "@/lib/db/client";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function issuePasswordResetToken(email: string): Promise<string | null> {
  const user = await query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND disabled = false LIMIT 1`, [email.trim().toLowerCase()]);
  if (!user.rows[0]) return null;
  const token = randomBytes(32).toString("base64url");
  await query(`UPDATE password_reset_tokens SET used_at = ${SQL_NOW} WHERE user_id = $1 AND used_at IS NULL`, [user.rows[0].id]);
  await query(`INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [user.rows[0].id, digest(token), new Date(Date.now() + 60 * 60 * 1000)]);
  return token;
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  const result = await query<{ id: string; user_id: string }>(
    `UPDATE password_reset_tokens SET used_at = ${SQL_NOW}
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > ${SQL_NOW}
     RETURNING id, user_id`,
    [digest(token)],
  );
  return result.rows[0]?.user_id ?? null;
}

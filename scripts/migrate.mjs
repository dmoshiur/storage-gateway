import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const connectionString = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required. Copy .env.example and configure PostgreSQL first.");
  process.exit(1);
}

const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.INITIAL_ADMIN_PASSWORD;
if (Boolean(email) !== Boolean(password)) {
  console.error("Set both INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, or neither.");
  process.exit(1);
}
if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 256)) {
  console.error("INITIAL_ADMIN_EMAIL must be a valid email address.");
  process.exit(1);
}
if (password && password.length < 12) {
  console.error("INITIAL_ADMIN_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('storage-gateway-migrations'))");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = path.join(root, "migrations");
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    const version = file.split("_")[0];
    const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
    if (rowCount) continue;
    const sql = await readFile(path.join(directory, file), "utf8");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    console.log(`Applied ${file}`);
  }

  if (email && password) {
    const result = await client.query(
      `INSERT INTO users(email, password_hash, display_name, role, email_verified_at)
       VALUES ($1, $2, $3, 'admin', now())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [email, hashPassword(password), "Administrator"],
    );
    if (result.rowCount) console.log(`Created initial administrator ${email}`);
    else console.log(`Initial administrator ${email} already exists; no password was changed.`);
  }

  await client.query("COMMIT");
  console.log("Database is ready.");
} catch (error) {
  await client?.query("ROLLBACK").catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

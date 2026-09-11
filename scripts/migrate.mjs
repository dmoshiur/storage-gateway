import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync } from "node:crypto";
import { createClient } from "@libsql/client";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = process.env.TURSO_DATABASE_URL?.trim()
  || process.env.DIRECT_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("TURSO_DATABASE_URL is required. Copy .env.example and configure Turso first.");
  process.exit(1);
}
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || process.env.DIRECT_DATABASE_AUTH_TOKEN?.trim() || undefined;

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
  console.error("INITIAL_ADMIN_PASSWORD must be at least 12 characters long.");
  process.exit(1);
}

/**
 * Splits a migration file into individual SQLite statements.
 * `Client.execute()` only runs the first statement of a multi-statement
 * string, so each statement must be sent on its own.
 */
function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      inString = !inString;
      current += char;
      continue;
    }
    if (!inString && char === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end - 1;
      current += "\n";
      continue;
    }
    if (!inString && char === ";") {
      statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current.trim());
  return statements
    .map((statement) => statement.replace(/^\n+/, "").trim())
    .filter((statement) => statement.replace(/\n/g, " ").trim().length > 0);
}

const db = createClient(authToken ? { url, authToken } : { url });
let transaction;
try {
  // SQLite serializes writers, so a single write transaction replaces the
  // PostgreSQL advisory lock previously used to make runs concurrency-safe.
  transaction = await db.transaction("write");
  await transaction.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );
  const directory = path.join(root, "migrations");
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    const version = file.split("_")[0];
    const seen = await transaction.execute({
      sql: "SELECT 1 FROM schema_migrations WHERE version = ?",
      args: [version],
    });
    if (seen.rows.length) continue;
    const sql = await readFile(path.join(directory, file), "utf8");
    const statements = splitStatements(sql).map((statement) => ({ sql: statement, args: [] }));
    await transaction.batch(statements, "write");
    await transaction.execute({
      sql: "INSERT INTO schema_migrations(version) VALUES (?)",
      args: [version],
    });
    console.log(`Applied ${file} (${statements.length} statements)`);
  }

  if (email && password) {
    const result = await transaction.execute({
      sql: `INSERT INTO users(email, password_hash, display_name, role, email_verified_at)
            VALUES (?, ?, ?, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            ON CONFLICT DO NOTHING
            RETURNING id`,
      args: [email, hashPassword(password), "Administrator"],
    });
    if (result.rows.length) console.log(`Created initial administrator ${email}`);
    else console.log(`Initial administrator ${email} already exists; no password was changed.`);
  }

  await transaction.commit();
  console.log("Database is ready.");
} catch (error) {
  await transaction?.rollback().catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

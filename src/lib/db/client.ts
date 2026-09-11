import "server-only";

import { createClient, type Client, type InValue, type ResultSet, type Transaction } from "@libsql/client";
import { ApiError } from "@/lib/api/errors";

/**
 * Turso (libSQL) data client.
 *
 * Replaces the previous node-postgres pool with `@libsql/client` behind the
 * same `query()` / `withTransaction()` surface, so the rest of the data layer
 * keeps working unchanged:
 *
 * - PostgreSQL `$1, $2, …` placeholders are translated to SQLite `?` binds.
 * - Bind values are coerced for SQLite (Date → ISO-8601 text, boolean → 1/0,
 *   arrays → JSON text, undefined → NULL).
 * - Result rows are decoded back to the shapes PostgreSQL returned
 *   (timestamps → Date, JSON/array columns → parsed values, 0/1 → boolean).
 * - All timestamps are stored as ISO-8601 UTC text (`2026-01-31T12:00:00.000Z`),
 *   which is both human readable and lexicographically comparable, matching
 *   the `strftime('%Y-%m-%dT%H:%M:%fZ','now')` DEFAULTs in the migrations.
 */

/**
 * Mirrors pg's QueryResultRow so row types without explicit index signatures
 * (e.g. `AuthUserRow`) remain valid generics, exactly as with node-postgres.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- mirrors @types/pg */
export interface QueryResultRow {
  [column: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * SQL expression for the current UTC timestamp in the exact format the
 * application stores everywhere else (identical to `new Date().toISOString()`).
 * Interpolate into queries as `SET updated_at = ${SQL_NOW}`.
 */
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

/** Columns persisted as JSON arrays of strings. */
const ARRAY_COLUMNS = new Set(["tags", "scopes", "events"]);
/** Columns persisted as JSON documents. */
const JSON_COLUMNS = new Set(["details", "value", "last_summary"]);
/** Columns persisted as 0/1 integers but consumed as booleans. */
const BOOLEAN_COLUMNS = new Set(["disabled", "is_favorite", "auto_delete_enabled", "enabled", "read"]);

let client: Client | undefined;

function configuration(): { url: string; authToken?: string } {
  const url = process.env.TURSO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new ApiError(503, "DATABASE_NOT_CONFIGURED", "Turso is not configured. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN and run npm run db:migrate.");
  }
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  return authToken ? { url, authToken } : { url };
}

export function getDb(): Client {
  if (!client) {
    client = createClient(configuration());
  }
  return client;
}

/**
 * Rewrites PostgreSQL `$1, $2, …` placeholders to SQLite's native numbered
 * `?1, ?2, …` binds. Numbered placeholders keep PostgreSQL semantics intact:
 * one argument, reusable at multiple positions.
 */
function translatePlaceholders(sql: string): string {
  if (!sql.includes("$")) return sql;
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === "'") {
      inString = !inString;
      out += char;
      continue;
    }
    if (!inString && char === "$") {
      const match = /^\$(\d+)/.exec(sql.slice(i));
      if (match) {
        out += `?${match[1]}`;
        i += match[0].length - 1;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/** Converts application values into bindable SQLite values. */
function toBindValue(value: unknown): InValue {
  if (value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  return value as InValue;
}

function decodeValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (key.endsWith("_at")) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date : value;
    }
    if (JSON_COLUMNS.has(key) || ARRAY_COLUMNS.has(key)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (ARRAY_COLUMNS.has(key) && !Array.isArray(parsed)) return value;
        return parsed;
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === "number" && BOOLEAN_COLUMNS.has(key) && (value === 0 || value === 1)) {
    return value === 1;
  }
  return value;
}

function toQueryResult<T extends QueryResultRow>(result: ResultSet): QueryResult<T> {
  const rows = result.rows.map((row) => {
    const decoded: Record<string, unknown> = {};
    for (const column of result.columns) {
      decoded[column] = decodeValue(column, (row as unknown as Record<string, unknown>)[column]);
    }
    return decoded as T;
  });
  // SELECT statements have rowsAffected = 0 in libSQL, UPDATE/DELETE without
  // RETURNING have no rows; `rows.length || rowsAffected` matches pg.rowCount.
  return { rows, rowCount: rows.length || result.rowsAffected };
}

function mapDbError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: string }).code ?? "";
  const rawCode = (error as { rawCode?: number }).rawCode;
  const message = error instanceof Error ? error.message : "Database query failed.";
  const constraint = code.startsWith("SQLITE_CONSTRAINT") || rawCode === 1555 || rawCode === 2067;
  if (constraint && (/UNIQUE constraint/i.test(message) || rawCode === 2067 || rawCode === 1555)) {
    return new ApiError(409, "RESOURCE_CONFLICT", "The requested resource already exists.");
  }
  console.error(JSON.stringify({ level: "error", message: "Turso query failed", error: message }));
  return new ApiError(503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable. Please retry shortly.");
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  try {
    const result = await getDb().execute({ sql: translatePlaceholders(text), args: values.map(toBindValue) });
    return toQueryResult<T>(result);
  } catch (error) {
    throw mapDbError(error);
  }
}

export async function withTransaction<T>(callback: (client: DbClient) => Promise<T>): Promise<T> {
  let transaction: Transaction | undefined;
  try {
    // "write" takes the database-level write lock up front, which gives the
    // same serialized guarantees PostgreSQL provided with `FOR UPDATE` and
    // advisory locks inside the callback.
    transaction = await getDb().transaction("write");
    const wrapped: DbClient = {
      async query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
        const result = await transaction!.execute({ sql: translatePlaceholders(text), args: values.map(toBindValue) });
        return toQueryResult<R>(result);
      },
    };
    const outcome = await callback(wrapped);
    await transaction.commit();
    return outcome;
  } catch (error) {
    await transaction?.rollback().catch(() => undefined);
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : "Database transaction failed.";
    console.error(JSON.stringify({ level: "error", message: "Turso transaction failed", error: message }));
    throw new ApiError(503, "DATABASE_UNAVAILABLE", "The database transaction could not be completed.");
  }
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

export function nullableIso(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null;
}

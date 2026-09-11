import "server-only";

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { ApiError } from "@/lib/api/errors";

let pool: Pool | undefined;

function connectionString(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new ApiError(503, "DATABASE_NOT_CONFIGURED", "PostgreSQL is not configured. Set DATABASE_URL and run npm run db:migrate.");
  }
  return value;
}

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      maxUses: 10_000,
      ssl: process.env.DATABASE_SSL === "disable" ? false : undefined,
    });
    pool.on("error", (error) => {
      console.error(JSON.stringify({ level: "error", message: "PostgreSQL idle client error", error: error.message }));
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
  try {
    return await getDb().query<T>(text, values);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code = (error as { code?: string }).code;
    if (code === "22P02") throw new ApiError(400, "INVALID_IDENTIFIER", "The supplied identifier is invalid.");
    if (code === "23505") throw new ApiError(409, "RESOURCE_CONFLICT", "The requested resource already exists.");
    const message = error instanceof Error ? error.message : "Database query failed.";
    console.error(JSON.stringify({ level: "error", message: "PostgreSQL query failed", error: message }));
    throw new ApiError(503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable. Please retry shortly.");
  }
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try {
    client = await getDb().connect();
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : "Database transaction failed.";
    console.error(JSON.stringify({ level: "error", message: "PostgreSQL transaction failed", error: message }));
    throw new ApiError(503, "DATABASE_UNAVAILABLE", "The database transaction could not be completed.");
  } finally {
    client?.release();
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

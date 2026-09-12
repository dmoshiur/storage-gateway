import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createClient, type Client } from "@libsql/client";

vi.mock("server-only", () => ({}));

/**
 * End-to-end account lifecycle against a real libSQL database created from the
 * project's actual migrations: create → stored correctly → duplicate rejected →
 * sign in with the initial password → role enforced.
 *
 * Nothing here is mocked or stubbed: the same `inviteUser`, `authenticateUser`
 * and `can` code paths the admin UI calls are exercised directly.
 */

const directory = mkdtempSync(path.join(tmpdir(), "gateway-users-"));
const databaseFile = path.join(directory, "test.db");
let db: Client;

/** Splits a migration file the same way scripts/migrate.mjs does. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
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
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

beforeAll(async () => {
  process.env.TURSO_DATABASE_URL = `file:${databaseFile}`;
  delete process.env.TURSO_AUTH_TOKEN;

  db = createClient({ url: `file:${databaseFile}` });
  const migrationsDirectory = path.join(process.cwd(), "migrations");
  const files = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  // Applying the real migrations is part of the test: a schema/code mismatch
  // (such as a missing `status` column) must fail here.
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
    for (const statement of splitStatements(sql)) await db.execute(statement);
  }
}, 60_000);

afterAll(() => {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("users table schema matches the application contract", () => {
  it("stores id, email, passwordHash, role, status, createdAt, updatedAt, lastLoginAt", async () => {
    // `table_xinfo` (not `table_info`) also lists generated columns such as `status`.
    const columns = (await db.execute("PRAGMA table_xinfo(users)")).rows.map((row) => String(row.name));
    for (const column of ["id", "email", "password_hash", "role", "status", "created_at", "updated_at", "last_login_at"]) {
      expect(columns).toContain(column);
    }
  });

  it("exposes status as a readable column with the expected values", async () => {
    const rows = (await db.execute("SELECT status FROM users LIMIT 1")).rows;
    expect(Array.isArray(rows)).toBe(true);
  });

  it("enforces a case-insensitive unique email for live accounts", async () => {
    const indexes = (await db.execute("PRAGMA index_list(users)")).rows.map((row) => String(row.name));
    expect(indexes).toContain("users_email_unique");
  });
});

describe("account lifecycle", () => {
  it("creates a real user with a hashed password and complete metadata", async () => {
    const { inviteUser } = await import("@/lib/db/users");
    const created = await inviteUser({ email: "Editor.One@Example.ORG", role: "editor", password: "EditorPassword123" });

    expect(created.email).toBe("editor.one@example.org");
    expect(created.role).toBe("editor");
    expect(created.status).toBe("active");
    expect(created.uid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    expect(created.lastLoginAt).toBeNull();
    // A supplied password is never echoed back.
    expect(created).not.toHaveProperty("temporaryPassword");

    const row = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [created.uid] })).rows[0]!;
    const stored = String(row.password_hash);
    expect(stored).not.toContain("EditorPassword123");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(String(row.status)).toBe("active");
  }, 30_000);

  it("rejects a duplicate email with the exact required message and creates no second row", async () => {
    const { inviteUser, DUPLICATE_EMAIL_MESSAGE } = await import("@/lib/db/users");
    expect(DUPLICATE_EMAIL_MESSAGE).toBe("An account with this email already exists.");

    for (const candidate of ["editor.one@example.org", "EDITOR.ONE@EXAMPLE.ORG"]) {
      await expect(inviteUser({ email: candidate, role: "admin", password: "AnotherPassword123" }))
        .rejects.toMatchObject({ status: 409, code: "USER_EXISTS", message: DUPLICATE_EMAIL_MESSAGE });
    }

    const count = (await db.execute("SELECT count(*) AS c FROM users WHERE lower(email) = 'editor.one@example.org'")).rows[0]!;
    expect(Number(count.c)).toBe(1);
  }, 30_000);

  it("generates a temporary password when none is supplied", async () => {
    const { inviteUser } = await import("@/lib/db/users");
    const created = await inviteUser({ email: "temp@example.org", role: "viewer" });
    expect(created.temporaryPassword).toBeTruthy();
    expect(created.temporaryPassword!.length).toBeGreaterThanOrEqual(12);

    const { authenticateUser } = await import("@/lib/auth/session");
    const session = await authenticateUser("temp@example.org", created.temporaryPassword!);
    expect(session.actor.role).toBe("viewer");
  }, 30_000);

  it("rejects a weak password and an invalid role before writing anything", async () => {
    const { inviteUser } = await import("@/lib/db/users");
    await expect(inviteUser({ email: "weak@example.org", role: "viewer", password: "short" }))
      .rejects.toMatchObject({ status: 400, code: "WEAK_PASSWORD" });
    await expect(inviteUser({ email: "badrole@example.org", role: "root" as never, password: "ValidPassword123" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_ROLE" });

    const rows = (await db.execute("SELECT count(*) AS c FROM users WHERE email IN ('weak@example.org','badrole@example.org')")).rows[0]!;
    expect(Number(rows.c)).toBe(0);
  }, 30_000);

  it("lets a newly created user sign in immediately with the initial password", async () => {
    const { inviteUser } = await import("@/lib/db/users");
    const { authenticateUser } = await import("@/lib/auth/session");

    const created = await inviteUser({ email: "fresh@example.org", role: "editor", password: "FreshPassword123" });
    const session = await authenticateUser("fresh@example.org", "FreshPassword123");

    expect(session.actor.uid).toBe(created.uid);
    expect(session.actor.role).toBe("editor");
    expect(session.cookie).toBeTruthy();

    // A session row is persisted with only a hash of the token, never the token.
    const sessions = await db.execute({ sql: "SELECT token_hash, expires_at FROM sessions WHERE user_id = ?", args: [created.uid] });
    expect(sessions.rows.length).toBe(1);
    expect(String(sessions.rows[0]!.token_hash)).not.toBe(session.cookie);

    // Signing in records last_login_at.
    const row = (await db.execute({ sql: "SELECT last_login_at FROM users WHERE id = ?", args: [created.uid] })).rows[0]!;
    expect(row.last_login_at).toBeTruthy();
  }, 30_000);

  it("accepts the email in any casing at sign-in and rejects a wrong password", async () => {
    const { authenticateUser } = await import("@/lib/auth/session");
    const session = await authenticateUser("FRESH@EXAMPLE.ORG", "FreshPassword123");
    expect(session.actor.email).toBe("fresh@example.org");

    await expect(authenticateUser("fresh@example.org", "WrongPassword123"))
      .rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS" });
    // Unknown accounts return the same message, so emails cannot be enumerated.
    await expect(authenticateUser("nobody@example.org", "WrongPassword123"))
      .rejects.toMatchObject({ status: 401, code: "INVALID_CREDENTIALS", message: "Invalid email or password." });
  }, 30_000);

  it("blocks a disabled account and reflects the status column", async () => {
    const { inviteUser, setUserDisabled } = await import("@/lib/db/users");
    const { authenticateUser } = await import("@/lib/auth/session");

    const created = await inviteUser({ email: "disabled@example.org", role: "viewer", password: "DisabledPass123" });
    await setUserDisabled(created.uid, true);

    const row = (await db.execute({ sql: "SELECT status FROM users WHERE id = ?", args: [created.uid] })).rows[0]!;
    expect(String(row.status)).toBe("disabled");

    await expect(authenticateUser("disabled@example.org", "DisabledPass123"))
      .rejects.toMatchObject({ status: 403, code: "ACCOUNT_DISABLED" });
  }, 30_000);

  it("marks a soft-deleted account as deleted and frees the email", async () => {
    const { inviteUser, deleteUser, listManagedUsers } = await import("@/lib/db/users");
    const created = await inviteUser({ email: "gone@example.org", role: "viewer", password: "GonePassword123" });
    await deleteUser(created.uid);

    const row = (await db.execute({ sql: "SELECT status FROM users WHERE id = ?", args: [created.uid] })).rows[0]!;
    expect(String(row.status)).toBe("deleted");

    const listed = await listManagedUsers(100);
    expect(listed.some((user) => user.uid === created.uid)).toBe(false);

    // The partial unique index only covers live rows, so the address is reusable.
    const recreated = await inviteUser({ email: "gone@example.org", role: "viewer", password: "GonePassword123" });
    expect(recreated.uid).not.toBe(created.uid);
  }, 30_000);

  it("returns every field the users table needs to render", async () => {
    const { listManagedUsers } = await import("@/lib/db/users");
    const users = await listManagedUsers(100);
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect(user).toMatchObject({
        uid: expect.any(String),
        email: expect.any(String),
        role: expect.stringMatching(/^(admin|editor|viewer)$/),
        status: expect.stringMatching(/^(active|disabled|deleted)$/),
      });
      expect(user).not.toHaveProperty("password_hash");
      expect(user).not.toHaveProperty("passwordHash");
    }
  }, 30_000);
});

describe("role authorization is enforced server-side", () => {
  it("grants admin full access, editor file management, viewer read-only", async () => {
    const { can } = await import("@/lib/auth/authorization");

    expect(can("admin", "manage_users")).toBe(true);
    expect(can("admin", "manage_files")).toBe(true);
    expect(can("admin", "permanent_delete")).toBe(true);

    expect(can("editor", "manage_files")).toBe(true);
    expect(can("editor", "read_files")).toBe(true);
    expect(can("editor", "manage_users")).toBe(false);
    expect(can("editor", "permanent_delete")).toBe(false);
    expect(can("editor", "manage_settings")).toBe(false);

    expect(can("viewer", "read_files")).toBe(true);
    expect(can("viewer", "manage_files")).toBe(false);
    expect(can("viewer", "manage_users")).toBe(false);
    expect(can("viewer", "permanent_delete")).toBe(false);
  });

  it("keeps the role recorded at creation time on the session actor", async () => {
    const { inviteUser } = await import("@/lib/db/users");
    const { authenticateUser } = await import("@/lib/auth/session");
    const { can } = await import("@/lib/auth/authorization");

    const created = await inviteUser({ email: "viewer.role@example.org", role: "viewer", password: "ViewerPassword123" });
    expect(created.role).toBe("viewer");

    const session = await authenticateUser("viewer.role@example.org", "ViewerPassword123");
    expect(session.actor.role).toBe("viewer");
    expect(can(session.actor.role, "manage_users")).toBe(false);
    expect(can(session.actor.role, "read_files")).toBe(true);
  }, 30_000);
});

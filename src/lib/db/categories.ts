import "server-only";

import { query, toDate, SQL_NOW } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";

export const DEFAULT_CATEGORIES = [
  "Reports",
  "Finance",
  "HR",
  "Project Documents",
  "Policies",
  "Legal",
  "Administrative",
  "Other",
] as const;

export interface CategoryRecord {
  id: string;
  name: string;
  description: string;
  color: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

function serialize(row: Record<string, unknown>): CategoryRecord {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: typeof row.description === "string" ? row.description : "",
    color: typeof row.color === "string" && row.color ? row.color : "slate",
    fileCount: Number(row.file_count ?? 0),
    createdAt: toDate(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
    updatedAt: toDate(row.updated_at)?.toISOString() ?? new Date(0).toISOString(),
  };
}

export async function listCategories(): Promise<CategoryRecord[]> {
  let result = await query(
    `SELECT c.id, c.name, c.description, c.color, c.created_at, c.updated_at,
            count(f.id) AS file_count
     FROM categories c LEFT JOIN files f ON lower(f.category) = lower(c.name) AND f.status = 'active'
     GROUP BY c.id ORDER BY c.name ASC`,
  );
  if (!result.rowCount) {
    for (const name of DEFAULT_CATEGORIES) {
      await query(`INSERT INTO categories(name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
    }
    result = await query(
      `SELECT c.id, c.name, c.description, c.color, c.created_at, c.updated_at,
              count(f.id) AS file_count
       FROM categories c LEFT JOIN files f ON lower(f.category) = lower(c.name) AND f.status = 'active'
       GROUP BY c.id ORDER BY c.name ASC`,
    );
  }
  return result.rows.map(serialize);
}

export async function createCategory(input: { name: string; description?: string; color?: string }): Promise<CategoryRecord> {
  const name = input.name.trim().slice(0, 80);
  try {
    const result = await query(
      `INSERT INTO categories(name, description, color) VALUES ($1, $2, $3)
       RETURNING id, name, description, color, created_at, updated_at, 0 AS file_count`,
      [name, input.description?.trim().slice(0, 200) ?? "", input.color?.trim().slice(0, 24) || "slate"],
    );
    return serialize(result.rows[0]!);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ApiError(409, "CATEGORY_EXISTS", "A category with that name already exists.");
    throw error;
  }
}

export async function updateCategory(id: string, patch: { name?: string; description?: string; color?: string }): Promise<CategoryRecord> {
  const result = await query(
    `UPDATE categories SET
       name = COALESCE($2, name), description = COALESCE($3, description), color = COALESCE($4, color), updated_at = ${SQL_NOW}
     WHERE id = $1
     RETURNING id, name, description, color, updated_at, created_at,
       (SELECT count(*) FROM files WHERE lower(category) = lower(categories.name) AND status = 'active') AS file_count`,
    [id, patch.name === undefined ? null : patch.name.trim().slice(0, 80), patch.description === undefined ? null : patch.description.trim().slice(0, 200), patch.color === undefined ? null : patch.color.trim().slice(0, 24) || "slate"],
  );
  if (!result.rowCount) throw new ApiError(404, "CATEGORY_NOT_FOUND", "The category was not found.");
  return serialize(result.rows[0]!);
}

export async function deleteCategory(id: string): Promise<void> {
  await query(`DELETE FROM categories WHERE id = $1`, [id]);
}

export async function getTagUsage(limit = 100): Promise<{ tag: string; count: number }[]> {
  const result = await query<{ tag: string; count: number }>(
    `SELECT lower(je.value) AS tag, count(*) AS count
     FROM files, json_each(files.tags) AS je
     WHERE status = 'active' GROUP BY lower(je.value) ORDER BY count DESC, tag ASC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)],
  );
  return result.rows.map((row) => ({ tag: row.tag, count: Number(row.count) }));
}

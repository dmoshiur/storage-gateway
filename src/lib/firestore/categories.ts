import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { asDate } from "@/utils/date";

const CATEGORIES = "categories";

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

function serialize(id: string, data: Record<string, unknown>): CategoryRecord {
  return {
    id,
    name: String(data.name ?? ""),
    description: typeof data.description === "string" ? data.description : "",
    color: typeof data.color === "string" && data.color ? data.color : "slate",
    fileCount: typeof data.fileCount === "number" ? data.fileCount : 0,
    createdAt: asDate(data.createdAt)?.toISOString() ?? new Date(0).toISOString(),
    updatedAt: asDate(data.updatedAt)?.toISOString() ?? new Date(0).toISOString(),
  };
}

export async function listCategories(): Promise<CategoryRecord[]> {
  const snapshot = await getAdminDb().collection(CATEGORIES).orderBy("name", "asc").get();
  if (snapshot.empty) {
    await seedDefaultCategories();
    const seeded = await getAdminDb().collection(CATEGORIES).orderBy("name", "asc").get();
    return seeded.docs.map((doc) => serialize(doc.id, doc.data()));
  }
  return snapshot.docs.map((doc) => serialize(doc.id, doc.data()));
}

async function seedDefaultCategories(): Promise<void> {
  const db = getAdminDb();
  const batch = db.batch();
  const now = new Date();
  for (const name of DEFAULT_CATEGORIES) {
    const ref = db.collection(CATEGORIES).doc(name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    batch.set(ref, { name, description: "", fileCount: 0, createdAt: now, updatedAt: now }, { merge: true });
  }
  await batch.commit();
}

export async function createCategory(input: { name: string; description?: string; color?: string }): Promise<CategoryRecord> {
  const name = input.name.trim().slice(0, 80);
  const now = new Date();
  const ref = await getAdminDb().collection(CATEGORIES).add({
    name,
    description: input.description?.trim().slice(0, 200) ?? "",
    color: input.color?.trim().slice(0, 24) || "slate",
    fileCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  const snapshot = await ref.get();
  return serialize(ref.id, snapshot.data() ?? {});
}

export async function updateCategory(id: string, patch: { name?: string; description?: string; color?: string }): Promise<CategoryRecord> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name.trim().slice(0, 80);
  if (patch.description !== undefined) updates.description = patch.description.trim().slice(0, 200);
  if (patch.color !== undefined) updates.color = patch.color.trim().slice(0, 24) || "slate";
  const ref = getAdminDb().collection(CATEGORIES).doc(id);
  await ref.set(updates, { merge: true });
  const snapshot = await ref.get();
  return serialize(id, snapshot.data() ?? {});
}

export async function deleteCategory(id: string): Promise<void> {
  await getAdminDb().collection(CATEGORIES).doc(id).delete();
}

/** Tag usage aggregated from active files (max 1000 scanned). */
export async function getTagUsage(limit = 100): Promise<{ tag: string; count: number }[]> {
  const snapshot = await getAdminDb().collection("files").where("status", "==", "active").limit(1000).get();
  const counts = new Map<string, number>();
  for (const doc of snapshot.docs) {
    const tags = doc.data().tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      const normalized = String(tag).toLowerCase();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

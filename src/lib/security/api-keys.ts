import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { toIso } from "@/utils/date";

const collection = () => getAdminDb().collection("apiKeys");

/**
 * Only a SHA-256 digest of the generated key is ever persisted. Firestore is
 * therefore useless to an attacker who reads the database, and raw keys can
 * never be listed again (they are displayed exactly once at creation time).
 */
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const snapshots = await collection().orderBy("createdAt", "desc").get();
  return snapshots.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      prefix: String(data.prefix ?? ""),
      createdAt: toIso(data.createdAt),
      lastUsedAt: toIso(data.lastUsedAt),
      revokedAt: toIso(data.revokedAt),
      createdBy: String(data.createdBy ?? ""),
    };
  });
}

/** Generates a high-entropy key. The raw value is returned exactly once. */
export async function createApiKey(actorUid: string): Promise<{ id: string; key: string }> {
  const key = `am_store_live_${randomBytes(32).toString("base64url")}`;
  const reference = await collection().add({
    keyHash: hash(key),
    prefix: key.slice(0, 22),
    createdAt: new Date(),
    createdBy: actorUid,
    revokedAt: null,
  });
  return { id: reference.id, key };
}

export async function revokeApiKey(id: string): Promise<void> {
  await collection().doc(id).update({ revokedAt: new Date() });
}

/**
 * Looks up a presented key by digest and returns its record id only when it is
 * active. A successful verification touches lastUsedAt so the dashboard can
 * show when a key was last used by an external site.
 */
export async function verifyApiKey(key: string): Promise<string | null> {
  const snapshots = await collection().where("keyHash", "==", hash(key)).limit(1).get();
  if (snapshots.empty || snapshots.docs[0]!.data().revokedAt) return null;
  await snapshots.docs[0]!.ref.update({ lastUsedAt: new Date() });
  return snapshots.docs[0]!.id;
}

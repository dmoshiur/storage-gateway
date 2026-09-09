import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";

const collection = () => getAdminDb().collection("apiKeys");
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
export async function listApiKeys() {
  const snap = await collection().orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.().toISOString() ?? null }));
}
export async function createApiKey(actorUid: string) {
  const key = `am_store_live_${randomBytes(32).toString("base64url")}`;
  const ref = await collection().add({ keyHash: hash(key), prefix: key.slice(0, 22), createdAt: new Date(), createdBy: actorUid, revokedAt: null });
  return { id: ref.id, key };
}
export async function revokeApiKey(id: string) { await collection().doc(id).update({ revokedAt: new Date() }); }
export async function verifyApiKey(key: string) {
  const snap = await collection().where("keyHash", "==", hash(key)).limit(1).get();
  if (snap.empty || snap.docs[0]!.data().revokedAt) return null;
  await snap.docs[0]!.ref.update({ lastUsedAt: new Date() });
  return snap.docs[0]!.id;
}

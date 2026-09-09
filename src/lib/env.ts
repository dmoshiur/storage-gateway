import "server-only";
import { z } from "zod";
import { ApiError } from "@/lib/api/errors";

const firebaseAdminSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(32),
});

const r2Schema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(3),
  R2_ENDPOINT: z.string().url(),
});

function configurationError(area: string, issues: string[]): never {
  // Details are intentionally logged server-side but not sent to callers.
  console.error(JSON.stringify({ level: "error", message: "Missing server configuration", area, issues }));
  throw new ApiError(503, "SERVICE_CONFIGURATION_ERROR", "This service is not configured yet. Contact an administrator.");
}

export function getFirebaseAdminEnv() {
  const parsed = firebaseAdminSchema.safeParse({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  });
  if (!parsed.success) return configurationError("firebase", parsed.error.issues.map((issue) => issue.path.join(".")));
  return { ...parsed.data, FIREBASE_PRIVATE_KEY: parsed.data.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") };
}

export function getR2Env() {
  const parsed = r2Schema.safeParse({
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
  });
  if (!parsed.success) return configurationError("r2", parsed.error.issues.map((issue) => issue.path.join(".")));
  return parsed.data;
}

export function getRequiredSecret(name: "INTEGRATION_API_KEY" | "CRON_SECRET"): string {
  const value = process.env[name];
  if (!value || value.length < 24) return configurationError("secret", [name]);
  return value;
}

export function getAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

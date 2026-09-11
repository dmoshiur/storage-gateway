#!/usr/bin/env node
/**
 * End-to-end Vercel Private Blob verification against a running deployment.
 *
 * Run this against the PRODUCTION deployment (or a local server) to prove the
 * real flow works with an actual PDF:
 *
 *   Admin UI → authenticated API → Vercel Blob → database metadata → response
 *
 *   node scripts/verify-blob.mjs \
 *     --base-url https://your-app.vercel.app \
 *     --email admin@example.org --password '…'
 *
 *   # or with a dashboard session cookie / API key instead of credentials
 *   node scripts/verify-blob.mjs --base-url https://… --cookie 'storage_gateway_session=…'
 *   node scripts/verify-blob.mjs --base-url https://… --api-key 'nfc_…'
 *
 * It never touches a mock or a filesystem store: every byte goes through the
 * deployment's own API into the configured Vercel Private Blob store.
 *
 * Steps (each one is reported, failures exit non-zero):
 *  1. Blob configuration + credentials probe        GET  /api/blob/health
 *  2. Real write/read/delete round-trip             GET  /api/blob/health?deep=true
 *  3. Authorize an upload for a real PDF            POST /api/files/upload/init
 *  4. Mint the presigned upload token (reaches Blob API)  POST /api/blob/upload
 *  5. Upload the PDF bytes to the presigned URL     PUT  <presigned URL>
 *  6. Verify + activate (header/trailer + size)     POST /api/files/:id/complete
 *  7. List metadata                                 GET  /api/files
 *  8. Preview bytes through the authenticated API   GET  /api/files/:id/preview?stream=true
 *  9. Download bytes (attachment)                   GET  /api/files/:id/download?stream=true
 * 10. Trash → restore                               DELETE /api/files/:id, POST /api/files/:id/restore
 * 11. Permanent delete (removes the private object) POST /api/files/:id/permanent-delete
 *
 * Notes:
 *  - `--api-key` drives the /api/v1 integration surface and skips steps 2/10/11
 *    (they are dashboard-only operations).
 *  - The presigned URL is assembled exactly like `@vercel/blob/client`
 *    `uploadPresigned` does in the browser: the server returns a signed
 *    payload, the client PUTs to `<blob api>/?pathname=…&vercel-blob-*`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_BLOB_API_URL = "https://vercel.com/api/blob";
const SESSION_COOKIE = "storage_gateway_session";

function parseArgs(argv) {
  const args = { blobApiUrl: process.env.BLOB_API_URL ?? DEFAULT_BLOB_API_URL, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (key === "--base-url") args.baseUrl = next;
    else if (key === "--email") args.email = next;
    else if (key === "--password") args.password = next;
    else if (key === "--cookie") args.cookie = next;
    else if (key === "--api-key") args.apiKey = next;
    else if (key === "--pdf") args.pdf = next;
    else if (key === "--blob-api-url") args.blobApiUrl = next;
    else if (key === "--keep") args.keep = true;
    else if (key === "--help") args.help = true;
    index += 1;
  }
  return args;
}

/** Builds a small but genuinely valid PDF (correct xref offsets + trailer). */
function buildPdf(lines = ["AM Storage — Vercel Private Blob verification"]) {
  const objects = [];
  const content = `BT /F1 12 Tf 40 750 Td (${lines.join(") Tj 0 -16 Td (")}) Tj ET`;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

const results = [];
let failed = false;

function report(step, ok, detail) {
  results.push({ step, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

function fail(step, error) {
  const message = error instanceof Error ? error.message : String(error);
  report(step, false, message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.baseUrl) {
    console.log(`Usage: node scripts/verify-blob.mjs --base-url https://app.example.com (--email … --password … | --cookie … | --api-key …) [--pdf file.pdf] [--blob-api-url ${DEFAULT_BLOB_API_URL}]`);
    process.exit(args.help ? 0 : 2);
  }

  const baseUrl = args.baseUrl.replace(/\/$/, "");
  const origin = new URL(baseUrl).origin;
  let cookie = args.cookie ?? null;

  const request = async (path, options = {}) => {
    const headers = { ...(options.headers ?? {}) };
    if (options.body) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie.includes("=") ? cookie : `${SESSION_COOKIE}=${cookie}`;
    if (args.apiKey) headers.authorization = `Bearer ${args.apiKey}`;
    // Mutating dashboard routes enforce same-origin requests.
    if (options.method && options.method !== "GET") headers.origin = origin;
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: "manual" });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return { response, payload, text };
  };

  const envelope = (payload) => (payload && typeof payload === "object" && "data" in payload ? payload.data : payload);

  // 0. Session
  if (!cookie && !args.apiKey) {
    if (!args.email || !args.password) {
      console.error("Provide --cookie, --api-key, or --email/--password.");
      process.exit(2);
    }
    const login = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: args.email, password: args.password }) });
    const setCookie = login.response.headers.getSetCookie?.() ?? [];
    const session = setCookie.map((value) => value.split(";")[0]).find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    if (!login.response.ok || !session) {
      report("login", false, `HTTP ${login.response.status} ${login.payload?.error?.message ?? login.text.slice(0, 200)}`);
      process.exit(1);
    }
    cookie = session;
    report("login", true, args.email);
  }

  // 1 + 2. Blob configuration and real round-trip probe.
  if (!args.apiKey) {
    try {
      const health = await request("/api/blob/health");
      const data = envelope(health.payload);
      if (!health.response.ok) throw new Error(`HTTP ${health.response.status} ${health.payload?.error?.message ?? ""}`);
      report(
        "blob configuration",
        Boolean(data?.configuration?.ok),
        `authMode=${data?.configuration?.authMode} storeId=${data?.configuration?.storeId ?? "—"} env=${data?.configuration?.vercelEnv ?? "—"}${data?.configuration?.missing?.length ? ` missing=${data.configuration.missing.join("+")}` : ""}`,
      );
      if (data?.error) report("blob probe", false, `${data.errorCode ?? ""} ${data.error} ${data.hint ?? ""}`);
      else report("blob probe (list)", Boolean(data?.probe?.reachable), `latency=${data?.probe?.latencyMs}ms objects=${data?.probe?.objectsVisible}`);
    } catch (error) {
      fail("blob configuration", error);
    }

    try {
      const deep = await request("/api/blob/health?deep=true");
      const data = envelope(deep.payload);
      if (!deep.response.ok) throw new Error(`HTTP ${deep.response.status} ${deep.payload?.error?.message ?? ""}`);
      const steps = data?.probe?.steps ?? [];
      report("blob deep probe (put/head/get/delete)", data?.status === "healthy", steps.map((step) => `${step.step}:${step.ok ? "ok" : "fail"}(${step.latencyMs}ms)`).join(" "));
      if (data?.error) report("blob deep probe error", false, `${data.errorCode} ${data.error} ${data.hint ?? ""}`);
    } catch (error) {
      fail("blob deep probe", error);
    }
  }

  // 3. Authorize an upload.
  const pdf = args.pdf ? await readFile(args.pdf) : buildPdf();
  const originalName = args.pdf ? args.pdf.split("/").pop() : `blob-verification-${Date.now()}.pdf`;
  const contentHash = createHash("sha256").update(pdf).digest("hex");

  let fileId;
  let pathname;
  try {
    const init = await request("/api/files/upload/init", {
      method: "POST",
      body: JSON.stringify({ originalName, size: pdf.byteLength, mimeType: "application/pdf", directToStorage: true, contentHash, category: "verification" }),
    });
    const data = envelope(init.payload);
    if (!init.response.ok) throw new Error(`HTTP ${init.response.status} ${init.payload?.error?.message ?? init.text.slice(0, 300)}`);
    fileId = data.file.id;
    pathname = data.pathname ?? data.file.storagePath;
    report("upload init", true, `file=${fileId} pathname=${pathname} bytes=${pdf.byteLength}`);
  } catch (error) {
    fail("upload init", error);
    process.exit(1);
  }

  // 4. Mint the presigned upload payload (this is the request that reaches the Blob API).
  try {
    const tokenResponse = await request("/api/blob/upload", {
      method: "POST",
      body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify({ fileId }), multipart: false } }),
    });
    const data = envelope(tokenResponse.payload) ?? tokenResponse.payload;
    if (!tokenResponse.response.ok) throw new Error(`HTTP ${tokenResponse.response.status} ${tokenResponse.payload?.error?.message ?? tokenResponse.text.slice(0, 300)}`);
    const payload = data.presignedUrlPayload;
    if (!payload?.delegationToken || !payload?.signature) throw new Error(`The server did not return a signed upload payload: ${tokenResponse.text.slice(0, 300)}`);
    report("presigned upload token", true, `type=${data.type} params=${Object.keys(payload.params ?? {}).length}`);

    // 5. PUT the bytes straight to Vercel Blob, exactly like the browser client.
    const uploadUrl = new URL("/", args.blobApiUrl.endsWith("/") ? args.blobApiUrl : `${args.blobApiUrl}/`);
    uploadUrl.searchParams.set("pathname", pathname);
    uploadUrl.searchParams.set("vercel-blob-delegation", payload.delegationToken);
    uploadUrl.searchParams.set("vercel-blob-signature", payload.signature);
    for (const [key, value] of Object.entries(payload.params ?? {})) uploadUrl.searchParams.set(key, value);

    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf", "x-content-type": "application/pdf" },
      body: pdf,
    });
    const putText = await put.text();
    if (!put.ok) throw new Error(`PUT ${uploadUrl.origin}${uploadUrl.pathname} → HTTP ${put.status} ${putText.slice(0, 300)}`);
    report("upload bytes to Blob", true, `${uploadUrl.origin} HTTP ${put.status}`);
  } catch (error) {
    fail("presigned upload", error);
    process.exit(1);
  }

  // 6. Verify + activate.
  try {
    const complete = await request(`/api/files/${fileId}/complete`, { method: "POST", body: JSON.stringify({ contentHash }) });
    const data = envelope(complete.payload);
    if (!complete.response.ok) throw new Error(`HTTP ${complete.response.status} ${complete.payload?.error?.message ?? complete.text.slice(0, 300)}`);
    report("verify + activate", data.file.status === "active", `status=${data.file.status} size=${data.file.size}`);
  } catch (error) {
    fail("verify + activate", error);
  }

  // 7. Metadata list.
  try {
    const list = await request(`/api/files?pageSize=100&status=active&filter=active&sort=newest`);
    const data = envelope(list.payload);
    const found = (data?.files ?? []).some((file) => file.id === fileId);
    report("metadata list", found, `title=${(data?.files ?? []).find((file) => file.id === fileId)?.originalName ?? "not found"}`);
  } catch (error) {
    fail("metadata list", error);
  }

  // 8 + 9. Preview and download the real bytes.
  const compareBytes = async (path, label) => {
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers: { ...(cookie ? { cookie } : {}), ...(args.apiKey ? { authorization: `Bearer ${args.apiKey}` } : {}) } });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status} ${text.slice(0, 300)}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const same = bytes.byteLength === pdf.byteLength && createHash("sha256").update(bytes).digest("hex") === contentHash;
      report(label, same, `${bytes.byteLength} bytes, sha256 ${same ? "matches" : "DIFFERS"}${response.headers.get("content-disposition") ? `, disposition=${response.headers.get("content-disposition").split(";")[0]}` : ""}`);
    } catch (error) {
      fail(label, error);
    }
  };
  await compareBytes(`/api/files/${fileId}/preview?stream=true`, "preview bytes");
  await compareBytes(`/api/files/${fileId}/download?stream=true&disposition=attachment`, "download bytes");

  if (args.apiKey) {
    console.log("\nAPI-key runs stop here (trash/restore/permanent-delete are dashboard-only).");
  } else if (!args.keep) {
    // 10. Trash → restore.
    try {
      const trash = await request(`/api/files/${fileId}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) });
      if (!trash.response.ok) throw new Error(`HTTP ${trash.response.status} ${trash.payload?.error?.message ?? ""}`);
      const restore = await request(`/api/files/${fileId}/restore`, { method: "POST", body: "{}" });
      const data = envelope(restore.payload);
      if (!restore.response.ok) throw new Error(`HTTP ${restore.response.status} ${restore.payload?.error?.message ?? ""}`);
      report("trash → restore", data.file.status === "active", `status=${data.file.status}`);
    } catch (error) {
      fail("trash → restore", error);
    }

    // 11. Permanent delete (removes the private object from the store).
    try {
      // Permanent deletion is only allowed from Trash, so trash the restored
      // document first (the UI follows the same state machine).
      await request(`/api/files/${fileId}`, { method: "DELETE", body: JSON.stringify({ confirmation: "MOVE_TO_TRASH" }) });
      const deleted = await request(`/api/files/${fileId}/permanent-delete`, { method: "POST", body: JSON.stringify({ confirmation: "DELETE" }) });
      const data = envelope(deleted.payload);
      if (!deleted.response.ok) throw new Error(`HTTP ${deleted.response.status} ${deleted.payload?.error?.message ?? ""}`);
      const after = await fetch(`${baseUrl}/api/files/${fileId}/preview?stream=true`, { headers: { cookie } });
      report("permanent delete", data.file.status === "deleted" && after.status === 404, `status=${data.file.status} preview-after-delete=HTTP ${after.status}`);
    } catch (error) {
      fail("permanent delete", error);
    }
  }

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${failed ? "VERIFICATION FAILED" : "VERIFICATION PASSED"} — ${passed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("Verification crashed:", error);
  process.exit(1);
});

/**
 * TEST-ONLY Vercel Blob API emulator.
 *
 * This file is NOT part of the application. Nothing under `src/` imports it and
 * it is never bundled into a deployment: production traffic always goes to
 * `https://vercel.com/api/blob` via `@vercel/blob`. It exists so the real
 * server code path (SDK → HTTP → response → database → UI) can be exercised
 * end-to-end on a machine with no Vercel credentials, proving that the
 * application sends correctly-formed, correctly-authenticated requests and
 * handles real responses.
 *
 * It implements the subset of the Vercel Blob control API that `@vercel/blob`
 * uses: POST /signed-token, PUT /?pathname=…, GET /?prefix=… (list),
 * GET /?url=… (head), POST /delete, POST /copy and object reads with Range
 * support. Auth headers are recorded (never validated) so tests can assert the
 * exact credential the SDK presented.
 *
 * Usage (in-process):  const emulator = await createBlobEmulator({ port: 0 });
 * Usage (CLI):         node tests/helpers/blob-emulator.mjs --port 8789
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseArgs(argv) {
  const args = { port: 0, storeId: "store_test", hostName: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = argv[index + 1];
    if (key === "--port" && next) args.port = Number(next);
    if (key === "--store-id" && next) args.storeId = next;
    if (key === "--host-name" && next) args.hostName = next;
  }
  return args;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Starts the emulator. Resolves with a handle exposing the API base URL, the
 * recorded request log, the stored objects and a `close()` method.
 */
export async function createBlobEmulator(options = {}) {
  const storeId = options.storeId ?? "store_test";
  const hostName = options.hostName ?? null;
  const objects = new Map(); // pathname -> { bytes, contentType, uploadedAt, etag }
  const requests = [];

  /** Failure injection: { matcher, status, code, message } applied to the next matching request. */
  let injectedFailure = null;

  const json = (response, status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  };

  const objectUrl = (pathname) =>
    `http://${hostName ?? "127.0.0.1"}:${server.address().port}/object/${pathname}`;

  const blobDescriptor = (pathname) => {
    const object = objects.get(pathname);
    return {
      url: objectUrl(pathname),
      downloadUrl: `${objectUrl(pathname)}?download=1`,
      pathname,
      size: object.bytes.byteLength,
      contentType: object.contentType,
      contentDisposition: "inline",
      cacheControl: "max-age=60",
      uploadedAt: object.uploadedAt,
      etag: object.etag,
    };
  };

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const record = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""])),
      bodyLength: body.byteLength,
      at: new Date().toISOString(),
    };
    requests.push(record);

    const fail = injectedFailure;
    if (fail && (fail.matcher === undefined || fail.matcher(record))) {
      injectedFailure = null;
      json(response, fail.status ?? 403, { error: { code: fail.code ?? "forbidden", message: fail.message ?? "Access denied" } });
      return;
    }

    // ---- object host: real bytes, Range support ---------------------------------
    if (url.pathname.startsWith("/object/")) {
      const pathname = decodeURIComponent(url.pathname.slice("/object/".length));
      const object = objects.get(pathname);
      if (!object) {
        json(response, 404, { error: { code: "not_found", message: "Blob not found" } });
        return;
      }
      const range = request.headers.range;
      let start = 0;
      let end = object.bytes.byteLength - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          if (match[1] === "" && match[2] !== "") {
            // Suffix range: last N bytes.
            start = Math.max(0, object.bytes.byteLength - Number(match[2]));
          } else {
            start = Number(match[1]);
            end = match[2] === "" ? object.bytes.byteLength - 1 : Number(match[2]);
          }
          end = Math.min(end, object.bytes.byteLength - 1);
          status = 206;
        }
      }
      const slice = object.bytes.subarray(start, end + 1);
      const headers = {
        "content-type": object.contentType,
        "content-length": String(slice.byteLength),
        etag: object.etag,
        "last-modified": new Date(object.uploadedAt).toUTCString(),
        "accept-ranges": "bytes",
      };
      if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${object.bytes.byteLength}`;
      response.writeHead(status, headers);
      response.end(slice);
      return;
    }

    // ---- control API -----------------------------------------------------------
    if (url.pathname.endsWith("/signed-token") && request.method === "POST") {
      const payload = JSON.parse(body.toString("utf8") || "{}");
      const validUntil = typeof payload.validUntil === "number" ? payload.validUntil : Date.now() + 3_600_000;
      const scope = {
        storeId,
        pathname: payload.pathname ?? "*",
        operations: payload.operations ?? ["get"],
        validUntil,
        ...(payload.allowedContentTypes ? { allowedContentTypes: payload.allowedContentTypes } : {}),
        ...(payload.maximumSizeInBytes ? { maximumSizeInBytes: payload.maximumSizeInBytes } : {}),
      };
      json(response, 200, {
        delegationToken: `${base64UrlEncode(JSON.stringify(scope))}.${randomUUID()}`,
        clientSigningToken: "test-client-signing-token",
        validUntil,
      });
      return;
    }

    if (url.pathname.endsWith("/delete") && request.method === "POST") {
      const payload = JSON.parse(body.toString("utf8") || "{}");
      for (const target of payload.urls ?? []) {
        const pathname = new URL(target).pathname.replace(/^\/object\//, "");
        objects.delete(decodeURIComponent(pathname));
      }
      json(response, 200, { deleted: true });
      return;
    }

    if (url.pathname.endsWith("/copy") && request.method === "POST") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const sourcePathname = decodeURIComponent(new URL(from).pathname.replace(/^\/object\//, ""));
      const source = objects.get(sourcePathname);
      if (!source) {
        json(response, 404, { error: { code: "not_found", message: "Blob not found" } });
        return;
      }
      objects.set(to, { ...source, uploadedAt: new Date().toISOString(), etag: createHash("sha256").update(randomUUID()).digest("hex") });
      json(response, 200, blobDescriptor(to));
      return;
    }

    if (request.method === "PUT" && url.searchParams.has("pathname")) {
      const pathname = url.searchParams.get("pathname");
      const fromUrl = url.searchParams.get("fromUrl");
      if (fromUrl) {
        // Server-side copy: `copy(fromUrl, pathname)`.
        const sourcePathname = decodeURIComponent(new URL(fromUrl).pathname.replace(/^\/object\//, ""));
        const source = objects.get(sourcePathname);
        if (!source) {
          json(response, 404, { error: { code: "not_found", message: "Blob not found" } });
          return;
        }
        objects.set(pathname, { ...source, uploadedAt: new Date().toISOString(), etag: createHash("sha256").update(randomUUID()).digest("hex") });
        json(response, 200, blobDescriptor(pathname));
        return;
      }
      const contentType = request.headers["x-content-type"] ?? request.headers["content-type"] ?? "application/octet-stream";
      objects.set(pathname, {
        bytes: body,
        contentType: String(contentType),
        uploadedAt: new Date().toISOString(),
        etag: createHash("sha256").update(body).digest("hex"),
      });
      json(response, 200, blobDescriptor(pathname));
      return;
    }

    if (request.method === "DELETE" && url.searchParams.has("pathname")) {
      objects.delete(url.searchParams.get("pathname"));
      json(response, 200, { deleted: true });
      return;
    }

    if (request.method === "GET" && url.searchParams.has("url")) {
      const pathname = decodeURIComponent(new URL(url.searchParams.get("url")).pathname.replace(/^\/object\//, ""));
      const object = objects.get(pathname);
      if (!object) {
        json(response, 404, { error: { code: "not_found", message: "Blob not found" } });
        return;
      }
      json(response, 200, blobDescriptor(pathname));
      return;
    }

    if (request.method === "GET") {
      // List: `?prefix=…&limit=…&mode=…`
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const blobs = [...objects.keys()]
        .filter((pathname) => pathname.startsWith(prefix))
        .sort()
        .slice(0, limit)
        .map(blobDescriptor);
      json(response, 200, { blobs, cursor: null, hasMore: false });
      return;
    }

    json(response, 404, { error: { code: "not_found", message: "Unhandled emulator route" } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    port,
    storeId,
    hostName,
    /** Base URL for the Vercel Blob API (`VERCEL_BLOB_API_URL`). */
    apiUrl: `http://127.0.0.1:${port}/api/blob`,
    hostFor(objectPathname) {
      return objectUrl(objectPathname);
    },
    requests,
    objects,
    seed(pathname, bytes, contentType = "application/pdf") {
      objects.set(pathname, {
        bytes: Buffer.from(bytes),
        contentType,
        uploadedAt: new Date().toISOString(),
        etag: createHash("sha256").update(bytes).digest("hex"),
      });
    },
    failNext(failure) {
      injectedFailure = failure;
    },
    /** Requests that reached the emulator, filtered by method and path fragment. */
    seen(method, pathFragment) {
      return requests.filter((entry) => entry.method === method && (!pathFragment || entry.path.includes(pathFragment)));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  const emulator = await createBlobEmulator(args);
  console.log(JSON.stringify({ level: "info", message: "Blob API emulator (test-only) listening", port: emulator.port, apiUrl: emulator.apiUrl, storeId: emulator.storeId, hostName: emulator.hostName }));
}

/**
 * Single source of truth for the public `/api/v1/*` endpoint surface.
 *
 * Both the API documentation tab and the API playground render from this list,
 * so it is impossible to advertise an endpoint that does not exist. Every entry
 * here maps to an implemented route under `src/app/api/v1/…`.
 */

export type EndpointMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface EndpointParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description: string;
}

export interface EndpointDef {
  method: EndpointMethod;
  /** Relative to the deployment origin, e.g. `/api/v1/files/:id`. */
  path: string;
  /** Required scope, or null for unauthenticated endpoints. */
  scope: string | null;
  summary: string;
  description: string;
  params: EndpointParam[];
  requestBody?: string;
  responseExample: string;
  errorResponses: { status: number; code: string; description: string }[];
}

export const V1_ENDPOINTS: EndpointDef[] = [
  {
    method: "GET",
    path: "/api/v1/files",
    scope: "files:read",
    summary: "List active files",
    description: "Returns a cursor-paginated list of active files, optionally filtered by search and category.",
    params: [
      { name: "search", in: "query", required: false, description: "Free-text search across title, original name, tags and uploader." },
      { name: "category", in: "query", required: false, description: "Filter by category name." },
      { name: "sort", in: "query", required: false, description: "newest | oldest | largest | smallest | delete_date | name (default newest)." },
      { name: "pageSize", in: "query", required: false, description: "1–100, default 25." },
      { name: "cursor", in: "query", required: false, description: "Opaque cursor from a previous page." },
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    responseExample: `{
  "success": true,
  "data": {
    "files": [
      { "id": "…", "title": "Annual report", "originalName": "annual-report.pdf",
        "mimeType": "application/pdf", "size": 2048576, "status": "active",
        "createdAt": "2026-09-01T10:00:00.000Z" }
    ],
    "nextCursor": "…",
    "searchLimited": false
  },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks files:read." },
      { status: 429, code: "RATE_LIMITED", description: "Too many requests." },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/files",
    scope: "files:upload",
    summary: "Upload a file",
    description: "Multipart upload of a single document (PDF, DOC, DOCX, TXT, PPT, PPTX). Files larger than ~4.5 MB should use the presigned flow.",
    params: [
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    requestBody: `multipart/form-data
  file        (required) the document bytes
  title       (optional) display title
  description (optional)
  category    (optional)
  tags        (optional) comma-separated`,
    responseExample: `{
  "success": true,
  "data": {
    "file": { "id": "…", "title": "Annual report", "status": "active", "size": 2048576 },
    "url": "https://…short-lived signed preview URL…",
    "expiresAt": "2026-09-01T11:00:00.000Z",
    "filename": "annual-report.pdf"
  },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 400, code: "INVALID_DOCUMENT", description: "The file is not a valid document." },
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks files:upload." },
      { status: 409, code: "STORAGE_LIMIT_EXCEEDED", description: "Storage quota exceeded." },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/files/:id",
    scope: "metadata:read",
    summary: "Get one file",
    description: "Returns the metadata for a single active file.",
    params: [
      { name: "id", in: "path", required: true, description: "The file id." },
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    responseExample: `{
  "success": true,
  "data": { "file": { "id": "…", "title": "Annual report", "status": "active", "size": 2048576 } },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks metadata:read." },
      { status: 404, code: "FILE_NOT_FOUND", description: "No such active file." },
    ],
  },
  {
    method: "PATCH",
    path: "/api/v1/files/:id",
    scope: "metadata:write",
    summary: "Update file metadata",
    description: "Updates title, description, category, tags, and/or retention policy.",
    params: [
      { name: "id", in: "path", required: true, description: "The file id." },
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    requestBody: `{
  "title": "Annual report 2026",
  "description": "Filed with the board",
  "category": "Reports",
  "tags": ["annual", "board"],
  "retention": { "autoDeleteEnabled": false }
}`,
    responseExample: `{
  "success": true,
  "data": { "file": { "id": "…", "title": "Annual report 2026" } },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 400, code: "VALIDATION_ERROR", description: "Invalid or empty body." },
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks metadata:write." },
      { status: 404, code: "FILE_NOT_FOUND", description: "No such active file." },
    ],
  },
  {
    method: "DELETE",
    path: "/api/v1/files/:id",
    scope: "files:delete",
    summary: "Move a file to Trash",
    description: "Moves the file to Trash where it stays recoverable until Trash retention expires.",
    params: [
      { name: "id", in: "path", required: true, description: "The file id." },
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    responseExample: `{
  "success": true,
  "data": { "file": { "id": "…", "status": "trash" } },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks files:delete." },
      { status: 404, code: "FILE_NOT_FOUND", description: "No such active file." },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/files/:id/download",
    scope: "files:download",
    summary: "Download a file",
    description: "Returns a short-lived, file-specific signed URL. Permanent Blob URLs are never exposed.",
    params: [
      { name: "id", in: "path", required: true, description: "The file id." },
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    responseExample: `{
  "success": true,
  "data": {
    "url": "https://…short-lived signed URL…",
    "expiresAt": "2026-09-01T11:00:00.000Z",
    "filename": "annual-report.pdf",
    "size": 2048576,
    "mimeType": "application/pdf"
  },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks files:download." },
      { status: 404, code: "FILE_NOT_FOUND", description: "No such active file." },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/files/:id/restore",
    scope: "files:update",
    summary: "Restore a trashed file",
    description: "Restores a file from Trash back to active status, recalculating elapsed retention policies.",
    params: [
      { name: "id", in: "path", required: true, description: "The file id." },
      { name: "Authorization", in: "header", required: true, description: "Bearer <API_KEY>" },
    ],
    responseExample: `{
  "success": true,
  "data": { "file": { "id": "…", "status": "active" } },
  "requestId": "req_…"
}`,
    errorResponses: [
      { status: 401, code: "INVALID_API_KEY", description: "Missing or invalid bearer key." },
      { status: 403, code: "INSUFFICIENT_SCOPE", description: "Key lacks files:update." },
      { status: 404, code: "FILE_NOT_FOUND", description: "No such trashed file." },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/health",
    scope: null,
    summary: "Service health",
    description: "Unauthenticated liveness probe returning the service version and Blob configuration state.",
    params: [],
    responseExample: `{
  "status": "ok",
  "service": "NGO File Cloud",
  "bridge": "ready",
  "mode": "embedded",
  "version": "1.0.0"
}`,
    errorResponses: [],
  },
];

export function endpointUrl(baseUrl: string, def: EndpointDef): string {
  return `${baseUrl}${def.path}`;
}

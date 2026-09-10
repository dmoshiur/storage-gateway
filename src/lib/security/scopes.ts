/**
 * Single source of truth for API scopes, shared by the dual-token bridge and
 * the public bearer-key API so the two systems can never drift apart.
 */
export const API_SCOPES = [
  "files:read",
  "files:upload",
  "files:update",
  "files:delete",
  "files:download",
  "metadata:read",
  "metadata:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

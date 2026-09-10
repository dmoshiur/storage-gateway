"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, KeyRound, Plus, RotateCw, ShieldAlert, Trash2 } from "lucide-react";
import { useConfirm, useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { Dialog } from "@/components/ui/overlays";
import { CopyButton, RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, Spinner, TableSkeleton } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { formatDate } from "@/utils/format";

interface ApiKey {
  id: string;
  keyId: string;
  prefix: string;
  name: string;
  description: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
}

interface Revealed {
  keyId: string;
  keySecret: string;
  name: string;
  previousKeyId: string | null;
  previousKeyName: string | null;
}

export function ApiKeysTab({ baseUrl }: { baseUrl: string }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refresh } = useQuery<{ keys: ApiKey[]; availableScopes: string[] }>("/api/api-keys");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState("");
  const [neverExpires, setNeverExpires] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Revealed | null>(null);
  const [detailsKey, setDetailsKey] = useState<ApiKey | null>(null);
  const [now] = useState(() => Date.now());

  const toggleScope = (scope: string) => {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const startCreate = () => {
    setName("");
    setDescription("");
    setScopes(new Set(data?.availableScopes ?? []));
    setExpiry("");
    setNeverExpires(true);
    setCreateOpen(true);
  };

  const errorOptions = (error: unknown, fallback: string) => ({
    message: error instanceof ClientApiError ? error.message : fallback,
    requestId: error instanceof ClientApiError ? error.requestId ?? undefined : undefined,
  });

  const create = async () => {
    setCreating(true);
    try {
      const created = await apiFetch<{ id: string; keyId: string; keySecret: string; name: string }>(
        "/api/api-keys",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            scopes: [...scopes],
            expiresAt: neverExpires || !expiry ? null : new Date(`${expiry}T23:59:59.000Z`).toISOString(),
          }),
        },
      );
      setCreateOpen(false);
      setReveal({ keyId: created.keyId, keySecret: created.keySecret, name: created.name, previousKeyId: null, previousKeyName: null });
      toast("API key created. Copy the secret now — it won't be shown again.", "warning");
      refresh();
    } catch (createError) {
      const opts = errorOptions(createError, "Unable to create API key.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: create });
    } finally {
      setCreating(false);
    }
  };

  const rotate = async (key: ApiKey) => {
    const ok = await confirm({
      title: `Rotate “${key.name}”?`,
      description: "A new key is issued with the same name, scopes and expiry. The current key keeps working until you confirm its revocation, so integrations can switch over safely.",
      confirmLabel: "Rotate key",
    });
    if (!ok) return;
    setPendingId(key.id);
    try {
      const rotated = await apiFetch<{ keyId: string; keySecret: string; name: string }>(`/api/api-keys?rotate=true`, {
        method: "PATCH",
        body: JSON.stringify({ id: key.id }),
      });
      setReveal({ keyId: rotated.keyId, keySecret: rotated.keySecret, name: rotated.name, previousKeyId: key.id, previousKeyName: key.name });
      toast("Key rotated. Copy the new secret now.", "warning");
      refresh();
    } catch (rotateError) {
      const opts = errorOptions(rotateError, "Unable to rotate API key.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => void rotate(key) });
    } finally {
      setPendingId(null);
    }
  };

  const revoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: "Revoke API key?",
      description: `This will immediately invalidate all requests using “${key.name}”. This cannot be undone.`,
      confirmLabel: "Revoke key",
      tone: "danger",
    });
    if (!ok) return;
    setPendingId(key.id);
    try {
      await apiFetch(`/api/api-keys?id=${encodeURIComponent(key.id)}`, { method: "DELETE" });
      toast("API key revoked.");
      refresh();
    } catch (revokeError) {
      const opts = errorOptions(revokeError, "Unable to revoke API key.");
      toast(opts.message, "error", { requestId: opts.requestId, retry: () => void revoke(key) });
    } finally {
      setPendingId(null);
    }
  };

  const revokePrevious = async (revealed: Revealed) => {
    if (!revealed.previousKeyId) return;
    const ok = await confirm({
      title: `Revoke the previous key “${revealed.previousKeyName}”?`,
      description: "This will immediately invalidate all requests using the previous key. Make sure every integration now uses the new key.",
      confirmLabel: "Revoke previous key",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/api-keys?id=${encodeURIComponent(revealed.previousKeyId)}`, { method: "DELETE" });
      toast("Previous key revoked.");
      setReveal({ ...revealed, previousKeyId: null, previousKeyName: null });
      refresh();
    } catch (revokeError) {
      const opts = errorOptions(revokeError, "Unable to revoke the previous key.");
      toast(opts.message, "error", { requestId: opts.requestId });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          Keys authenticate requests to <span className="font-mono">{baseUrl || "your deployment"}/api/v1</span> as{" "}
          <span className="font-mono">Authorization: Bearer ng_live_…</span>. Secrets are stored hashed and shown exactly once.
        </p>
        <button type="button" className="btn-primary btn-sm" onClick={startCreate}>
          <Plus className="h-4 w-4" /> Create API key
        </button>
      </div>

      {loading && <TableSkeleton rows={3} columns={5} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && (data?.keys.length ?? 0) === 0 && (
        <div className="tbl-wrap">
          <EmptyState
            icon={<KeyRound className="h-6 w-6" />}
            title="No API keys yet"
            description="Create a key to let your NGO website list, upload, and download documents."
            action={<button type="button" className="btn-primary btn-sm" onClick={startCreate}><Plus className="h-4 w-4" /> Create API key</button>}
          />
        </div>
      )}
      {!loading && !error && (data?.keys.length ?? 0) > 0 && (
        <div className="grid gap-3">
          {data!.keys.map((key) => {
            const revoked = Boolean(key.revokedAt);
            const expired = !revoked && Boolean(key.expiresAt && new Date(key.expiresAt).getTime() <= now);
            return (
              <div key={key.id} className={`card-pad ${revoked ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[15px] font-semibold text-ink">{key.name}</h3>
                      {revoked ? <span className="badge-danger">Revoked</span>
                        : expired ? <span className="badge-danger">Expired</span>
                          : <span className="badge-success">Active</span>}
                    </div>
                    {key.description && <p className="mt-0.5 text-[13px] text-ink-muted">{key.description}</p>}
                    <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-ink-faint">
                      <span className="truncate">{key.keyId}</span>
                      <CopyButton value={key.keyId} label="Copy identifier" />
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      Created {formatDate(key.createdAt)} · Last used {key.lastUsedAt ? <RelativeTime iso={key.lastUsedAt} /> : "never"}
                      {key.expiresAt ? ` · Expires ${formatDate(key.expiresAt)}` : " · Never expires"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {key.scopes.map((scope) => (
                        <span key={scope} className="badge-neutral font-mono">{scope}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {!revoked && (
                      <>
                        <button type="button" className="btn-secondary btn-sm" disabled={pendingId === key.id} onClick={() => rotate(key)}>
                          {pendingId === key.id ? <Spinner /> : <RotateCw className="h-3.5 w-3.5" />} Rotate
                        </button>
                        <button type="button" className="btn-danger-soft btn-sm" disabled={pendingId === key.id} onClick={() => revoke(key)}>
                          <Trash2 className="h-3.5 w-3.5" /> Revoke
                        </button>
                      </>
                    )}
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setDetailsKey(key)}>View details</button>
                    <Link href="/admin/activity" className="btn-secondary btn-sm"><Activity className="h-3.5 w-3.5" /> View usage</Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {createOpen && (
        <Dialog title="Create API key" description="Choose a name, scopes, and optional expiry." onClose={() => setCreateOpen(false)} dismissable={!creating}>
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="key-name">Name</label>
              <input id="key-name" className="field-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Website Production" />
            </div>
            <div>
              <label className="field-label" htmlFor="key-desc">Description</label>
              <input id="key-desc" className="field-input" value={description} maxLength={280} onChange={(event) => setDescription(event.target.value)} placeholder="Used by the public NGO website" />
            </div>
            <div>
              <span className="field-label">Scopes</span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(data?.availableScopes ?? []).map((scope) => (
                  <label key={scope} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-surface-sunken">
                    <input type="checkbox" className="field-check" checked={scopes.has(scope)} onChange={() => toggleScope(scope)} />
                    <span className="font-mono text-xs">{scope}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                <input type="checkbox" className="field-check h-4 w-4" checked={neverExpires} onChange={(event) => setNeverExpires(event.target.checked)} />
                <span className="text-ink">Never expires</span>
              </label>
              {!neverExpires && (
                <div className="mt-2">
                  <label className="field-label" htmlFor="key-expiry">Expiration date</label>
                  <input id="key-expiry" type="date" className="field-input" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2.5">
              <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</button>
              <button type="button" className="btn-primary" onClick={create} disabled={creating || scopes.size === 0 || !name.trim()}>
                {creating && <Spinner />} {creating ? "Creating…" : "Create key"}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {reveal && (
        <Dialog title="Copy your API key" description="This is the only time the full secret is shown." onClose={() => setReveal(null)}>
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Your API key will not be shown again. Store “{reveal.name}” securely — after closing, the secret can only be rotated or revoked.</span>
            </div>
            <div>
              <span className="field-label">Key ID</span>
              <p className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-xs">
                <span className="truncate">{reveal.keyId}</span>
                <CopyButton value={reveal.keyId} label="Copy key ID" />
              </p>
            </div>
            <div>
              <span className="field-label">Key secret</span>
              <p className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-xs">
                <span className="truncate">{reveal.keySecret}</span>
                <CopyButton value={reveal.keySecret} label="Copy API key" />
              </p>
            </div>
            {reveal.previousKeyId && (
              <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
                <p className="text-[13px] text-ink">
                  The previous key “{reveal.previousKeyName}” is still active. Revoke it once every integration uses the new key.
                </p>
                <button type="button" className="btn-danger-soft btn-sm mt-2" onClick={() => void revokePrevious(reveal)}>
                  <Trash2 className="h-3.5 w-3.5" /> Revoke previous key
                </button>
              </div>
            )}
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={() => setReveal(null)}>Done</button>
            </div>
          </div>
        </Dialog>
      )}

      {detailsKey && (
        <Dialog title={detailsKey.name} description="API key details" onClose={() => setDetailsKey(null)}>
          <dl className="divide-y divide-line">
            {[
              ["Identifier", detailsKey.keyId],
              ["Created", formatDate(detailsKey.createdAt)],
              ["Last used", detailsKey.lastUsedAt ? formatDate(detailsKey.lastUsedAt) : "Never"],
              ["Expires", detailsKey.expiresAt ? formatDate(detailsKey.expiresAt) : "Never"],
              ["Created by", detailsKey.createdBy || "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-3 py-2">
                <dt className="text-[13px] text-ink-muted">{label}</dt>
                <dd className="min-w-0 text-right font-mono text-xs text-ink">{value}</dd>
              </div>
            ))}
            <div className="flex items-start justify-between gap-3 py-2">
              <dt className="text-[13px] text-ink-muted">Scopes</dt>
              <dd className="flex max-w-[60%] flex-wrap justify-end gap-1.5">
                {detailsKey.scopes.map((scope) => <span key={scope} className="badge-neutral font-mono">{scope}</span>)}
              </dd>
            </div>
          </dl>
          <div className="mt-4 flex justify-end">
            <button type="button" className="btn-primary" onClick={() => setDetailsKey(null)}>Close</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

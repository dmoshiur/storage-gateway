"use client";

import { useState } from "react";
import { KeyRound, Plus, RotateCw, Trash2 } from "lucide-react";
import { useConfirm, useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { Dialog } from "@/components/ui/overlays";
import { CopyButton, RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, Spinner, TableSkeleton } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { formatDate } from "@/utils/format";

interface ApiKey {
  id: string;
  keyId: string | null;
  prefix: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string;
}

export function ApiKeysTab() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refresh } = useQuery<{ keys: ApiKey[]; availableScopes: string[] }>("/api/api-keys");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ keyId: string; keySecret: string; name: string } | null>(null);
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
    setScopes(new Set(data?.availableScopes ?? []));
    setExpiry("");
    setCreateOpen(true);
  };

  const create = async () => {
    setBusy(true);
    try {
      const created = await apiFetch<{ id: string; keyId: string; keySecret: string; name: string }>(
        "/api/api-keys",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim() || undefined,
            scopes: [...scopes],
            expiresAt: expiry ? new Date(`${expiry}T00:00:00.000Z`).toISOString() : null,
          }),
        },
      );
      setCreateOpen(false);
      setReveal(created);
      toast("API key created. Copy the secret now — it won't be shown again.", "warning");
      refresh();
    } catch (createError) {
      toast(createError instanceof ClientApiError ? createError.message : "Creation failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (key: ApiKey) => {
    const ok = await confirm({
      title: `Rotate “${key.name}”?`,
      description: "The current secret stops working immediately. Update every integration with the new secret.",
      confirmLabel: "Rotate key",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const rotated = await apiFetch<{ keyId: string; keySecret: string }>(`/api/api-keys?rotate=true`, {
        method: "PATCH",
        body: JSON.stringify({ id: key.id }),
      });
      setReveal({ ...rotated, name: key.name });
      toast("Key rotated. Copy the new secret now.", "warning");
      refresh();
    } catch (rotateError) {
      toast(rotateError instanceof ClientApiError ? rotateError.message : "Rotation failed.", "error");
    }
  };

  const revoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: `Revoke “${key.name}”?`,
      description: "Integrations using this key will stop working immediately. This cannot be undone.",
      confirmLabel: "Revoke key",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/api-keys?id=${encodeURIComponent(key.id)}`, { method: "DELETE" });
      toast("API key revoked.");
      refresh();
    } catch (revokeError) {
      toast(revokeError instanceof ClientApiError ? revokeError.message : "Revocation failed.", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          Connect your main website to the document platform. Secrets are stored hashed and shown exactly once.
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
            description="Create a key to let your main website list, upload, and download documents."
            action={<button type="button" className="btn-primary btn-sm" onClick={startCreate}><Plus className="h-4 w-4" /> Create API key</button>}
          />
        </div>
      )}
      {!loading && !error && (data?.keys.length ?? 0) > 0 && (
        <div className="grid gap-3">
          {data!.keys.map((key) => (
            <div key={key.id} className={`card-pad ${key.revokedAt ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold text-ink">{key.name}</h3>
                    {key.revokedAt ? <span className="badge-danger">Revoked</span>
                      : key.expiresAt && new Date(key.expiresAt).getTime() <= now ? <span className="badge-danger">Expired</span>
                        : <span className="badge-success">Active</span>}
                  </div>
                  <p className="mt-1 font-mono text-xs text-ink-faint">{key.keyId ?? key.prefix}</p>
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
                {!key.revokedAt && (
                  <div className="flex items-center gap-1.5">
                    <button type="button" className="btn-secondary btn-sm" onClick={() => rotate(key)}>
                      <RotateCw className="h-3.5 w-3.5" /> Rotate
                    </button>
                    <button type="button" className="btn-danger-soft btn-sm" onClick={() => revoke(key)}>
                      <Trash2 className="h-3.5 w-3.5" /> Revoke
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen && (
        <Dialog title="Create API key" description="Choose a name, scopes, and optional expiry." onClose={() => setCreateOpen(false)}>
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="key-name">Name</label>
              <input id="key-name" className="field-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Website Production" />
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
              <label className="field-label" htmlFor="key-expiry">Expiry (optional)</label>
              <input id="key-expiry" type="date" className="field-input" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            </div>
            <div className="flex justify-end gap-2.5">
              <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary" onClick={create} disabled={busy || scopes.size === 0}>
                {busy && <Spinner />} Create key
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {reveal && (
        <Dialog title="Copy your secret" description="This is the only time the full secret is shown." onClose={() => setReveal(null)}>
          <div className="space-y-3">
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
              Store “{reveal.name}” securely. After closing, the secret cannot be viewed again — only rotated or revoked.
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
                <CopyButton value={reveal.keySecret} label="Copy key secret" />
              </p>
            </div>
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={() => setReveal(null)}>Done</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

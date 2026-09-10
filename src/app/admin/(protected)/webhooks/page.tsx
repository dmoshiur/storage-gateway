"use client";

import { useState } from "react";
import { Plug, Plus, RotateCw, Send, Trash2 } from "lucide-react";
import { useConfirm, useToast } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { Dialog } from "@/components/ui/overlays";
import { CopyButton, RelativeTime } from "@/components/ui/data";
import { EmptyState, ErrorState, Spinner, TableSkeleton } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { WEBHOOK_EVENTS, type WebhookDelivery, type WebhookEvent, type WebhookRecord } from "@/types/webhook";
import { formatDate } from "@/utils/format";

function Deliveries({ webhookId }: { webhookId: string }) {
  const { data, loading } = useQuery<{ deliveries: WebhookDelivery[] }>(`/api/webhooks/${webhookId}`);
  if (loading) return <p className="py-3 text-center text-xs text-ink-faint">Loading deliveries…</p>;
  const deliveries = data?.deliveries ?? [];
  if (deliveries.length === 0) return <p className="py-3 text-center text-xs text-ink-faint">No deliveries yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {deliveries.slice(0, 10).map((delivery) => (
        <li key={delivery.id} className="flex items-center justify-between gap-3 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <span className={delivery.status === "success" ? "badge-success" : "badge-danger"}>
              {delivery.status === "success" ? `HTTP ${delivery.statusCode ?? "—"}` : "failed"}
            </span>
            <span className="truncate font-mono text-ink-muted">{delivery.event}</span>
          </div>
          <span className="tnum shrink-0 text-ink-faint">
            {delivery.durationMs} ms · <RelativeTime iso={delivery.createdAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function WebhooksPage() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refresh } = useQuery<{ webhooks: WebhookRecord[] }>("/api/webhooks");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<Set<WebhookEvent>>(new Set(WEBHOOK_EVENTS));
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<{ name: string; secret: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggleEvent = (event: WebhookEvent) => {
    setEvents((current) => {
      const next = new Set(current);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return next;
    });
  };

  const startCreate = () => {
    setName("");
    setUrl("");
    setEvents(new Set(WEBHOOK_EVENTS));
    setOpen(true);
  };

  const create = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<{ webhook: WebhookRecord; secret: string }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), url: url.trim(), events: [...events] }),
      });
      setOpen(false);
      setReveal({ name: result.webhook.name, secret: result.secret });
      toast("Webhook created. Copy the signing secret now.", "warning");
      refresh();
    } catch (createError) {
      toast(createError instanceof ClientApiError ? createError.message : "Creation failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (webhook: WebhookRecord) => {
    try {
      await apiFetch(`/api/webhooks/${webhook.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !webhook.enabled }) });
      toast(webhook.enabled ? "Webhook disabled." : "Webhook enabled.");
      refresh();
    } catch (updateError) {
      toast(updateError instanceof ClientApiError ? updateError.message : "Update failed.", "error");
    }
  };

  const rotate = async (webhook: WebhookRecord) => {
    const ok = await confirm({
      title: `Rotate the signing secret for “${webhook.name}”?`,
      description: "The old secret stops working immediately. Update the receiver to verify with the new secret.",
      confirmLabel: "Rotate secret",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const result = await apiFetch<{ secret: string }>(`/api/webhooks/${webhook.id}/rotate`, { method: "POST" });
      setReveal({ name: webhook.name, secret: result.secret });
      toast("Secret rotated. Copy it now.", "warning");
      refresh();
    } catch (rotateError) {
      toast(rotateError instanceof ClientApiError ? rotateError.message : "Rotation failed.", "error");
    }
  };

  const test = async (webhook: WebhookRecord) => {
    setTesting(webhook.id);
    try {
      const result = await apiFetch<{ delivered: boolean; statusCode: number | null }>(
        `/api/webhooks/${webhook.id}/test`,
        { method: "POST" },
      );
      toast(
        result.delivered ? `Test delivered (HTTP ${result.statusCode ?? "—"}).` : `Test failed (HTTP ${result.statusCode ?? "—"}).`,
        result.delivered ? "success" : "error",
      );
      refresh();
    } catch (testError) {
      toast(testError instanceof ClientApiError ? testError.message : "Test failed.", "error");
    } finally {
      setTesting(null);
    }
  };

  const remove = async (webhook: WebhookRecord) => {
    const ok = await confirm({
      title: `Delete “${webhook.name}”?`,
      description: `Events will stop being delivered to ${webhook.url}.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/webhooks/${webhook.id}`, { method: "DELETE" });
      toast("Webhook deleted.");
      refresh();
    } catch (deleteError) {
      toast(deleteError instanceof ClientApiError ? deleteError.message : "Deletion failed.", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Webhooks</h1>
          <p className="page-sub">Notify external systems in real time when documents change.</p>
        </div>
        <button type="button" className="btn-primary btn-sm" onClick={startCreate}>
          <Plus className="h-4 w-4" /> Add webhook
        </button>
      </div>

      <div className="card-pad">
        <h2 className="panel-title">How verification works</h2>
        <p className="mt-1 text-[13px] leading-6 text-ink-muted">
          Each delivery posts JSON with an <code className="font-mono text-xs">X-Webhook-Signature</code> HMAC-SHA256
          header (computed over the raw body with your signing secret) plus{" "}
          <code className="font-mono text-xs">X-Webhook-Event</code>. Signing secrets are shown once, at creation or
          rotation. Endpoints must use HTTPS.
        </p>
      </div>

      {loading && <TableSkeleton rows={3} columns={4} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && (data?.webhooks.length ?? 0) === 0 && (
        <div className="tbl-wrap">
          <EmptyState
            icon={<Plug className="h-6 w-6" />}
            title="No webhooks yet"
            description="Add an HTTPS URL to receive file.uploaded, file.deleted, and other events."
            action={<button type="button" className="btn-primary btn-sm" onClick={startCreate}><Plus className="h-4 w-4" /> Add webhook</button>}
          />
        </div>
      )}
      {!loading && !error && (data?.webhooks.length ?? 0) > 0 && (
        <div className="grid gap-3">
          {data!.webhooks.map((webhook) => (
            <div key={webhook.id} className="card-pad">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-semibold text-ink">{webhook.name}</h3>
                    {webhook.enabled ? <span className="badge-success">Enabled</span> : <span className="badge-neutral">Disabled</span>}
                    {webhook.failureCount > 0 && <span className="badge-danger">{webhook.failureCount} failures</span>}
                    {webhook.lastStatus === "success" && <span className="badge-success">Last delivery ok</span>}
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-ink-faint">{webhook.url}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {webhook.events.map((event) => (
                      <span key={event} className="badge-neutral font-mono">{event}</span>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-ink-muted">
                    Last triggered {webhook.lastTriggeredAt ? <RelativeTime iso={webhook.lastTriggeredAt} /> : "never"} · Created {formatDate(webhook.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setExpanded(expanded === webhook.id ? null : webhook.id)}>
                    {expanded === webhook.id ? "Hide deliveries" : "Deliveries"}
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => test(webhook)} disabled={testing === webhook.id}>
                    {testing === webhook.id ? <Spinner /> : <Send className="h-3.5 w-3.5" />} Send test
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => toggleEnabled(webhook)}>
                    {webhook.enabled ? "Disable" : "Enable"}
                  </button>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => rotate(webhook)}>
                    <RotateCw className="h-3.5 w-3.5" /> Rotate secret
                  </button>
                  <button type="button" className="btn-danger-soft btn-sm" onClick={() => remove(webhook)}>
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
              {expanded === webhook.id && (
                <div className="mt-3 border-t border-line pt-2">
                  <Deliveries webhookId={webhook.id} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <Dialog title="Add webhook" description="Events are delivered as signed HTTPS POST requests." onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="hook-name">Name</label>
              <input id="hook-name" className="field-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Website sync" />
            </div>
            <div>
              <label className="field-label" htmlFor="hook-url">Endpoint URL (HTTPS)</label>
              <input id="hook-url" className="field-input font-mono text-[13px]" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://your-site.org/hooks/documents" />
            </div>
            <div>
              <span className="field-label">Events</span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {WEBHOOK_EVENTS.map((event) => (
                  <label key={event} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 hover:bg-surface-sunken">
                    <input type="checkbox" className="field-check" checked={events.has(event)} onChange={() => toggleEvent(event)} />
                    <span className="font-mono text-xs">{event}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2.5">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary" onClick={create} disabled={busy || !name.trim() || !url.trim() || events.size === 0}>
                {busy && <Spinner />} Add webhook
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {reveal && (
        <Dialog title="Copy your signing secret" description="This is the only time the full secret is shown." onClose={() => setReveal(null)}>
          <div className="space-y-3">
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
              Configure “{reveal.name}” on the receiving end to verify the HMAC signature with this secret.
            </div>
            <p className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-xs">
              <span className="truncate">{reveal.secret}</span>
              <CopyButton value={reveal.secret} label="Copy signing secret" />
            </p>
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={() => setReveal(null)}>Done</button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

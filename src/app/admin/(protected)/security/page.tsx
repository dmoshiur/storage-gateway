"use client";

import { ShieldCheck } from "lucide-react";
import { useSession } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { RelativeTime, Stat } from "@/components/ui/data";
import { EmptyState, ErrorState, CardsSkeleton } from "@/components/ui/feedback";
import type { SerializedAuditLog } from "@/types/audit";

const SECURITY_ACTIONS = new Set([
  "LOGIN",
  "LOGOUT",
  "LOGIN_FAILED",
  "USER_ROLE_CHANGED",
  "USER_DISABLED",
  "USER_ENABLED",
  "USER_INVITED",
  "API_KEY_CREATED",
  "API_KEY_ROTATED",
  "API_KEY_REVOKED",
  "SETTINGS_CHANGE",
]);

export default function SecurityPage() {
  const { session } = useSession();
  const { data, error, loading, refresh } = useQuery<{ logs: SerializedAuditLog[] }>(session?.role === "admin" ? "/api/audit-logs?pageSize=100" : null);

  if (session && session.role !== "admin") {
    return (
      <div className="tbl-wrap">
        <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="Admins only" description="The security center requires the administrator role." />
      </div>
    );
  }

  const events = (data?.logs ?? []).filter((log) => SECURITY_ACTIONS.has(log.action));
  const failedLogins = events.filter((log) => log.action === "LOGIN_FAILED").length;
  const roleChanges = events.filter((log) => log.action === "USER_ROLE_CHANGED").length;
  const keyEvents = events.filter((log) => log.action.startsWith("API_KEY")).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Security</h1>
        <p className="page-sub">Authentication posture, access events, and sensitive changes.</p>
      </div>

      {loading && <CardsSkeleton count={3} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Failed sign-ins" value={failedLogins} detail="In the last 100 audit events" />
            <Stat label="Role changes" value={roleChanges} detail="In the last 100 audit events" />
            <Stat label="API key events" value={keyEvents} detail="Created, rotated, or revoked" />
          </div>
          <div className="card-pad">
            <h2 className="panel-title">Posture</h2>
            <ul className="mt-3 space-y-2.5 text-[13px]">
              <li className="flex items-center justify-between gap-3"><span className="text-ink-muted">Authentication</span><span className="badge-success">Firebase Auth · HTTP-only sessions</span></li>
              <li className="flex items-center justify-between gap-3"><span className="text-ink-muted">Object storage</span><span className="badge-success">Private Blob · signed URLs only</span></li>
              <li className="flex items-center justify-between gap-3"><span className="text-ink-muted">API secrets</span><span className="badge-success">Hashed · shown once</span></li>
              <li className="flex items-center justify-between gap-3"><span className="text-ink-muted">Rate limiting</span><span className="badge-success">Enabled on auth, upload & API</span></li>
              <li className="flex items-center justify-between gap-3"><span className="text-ink-muted">MFA</span><span className="badge-neutral">Planned</span></li>
              <li className="flex items-center justify-between gap-3"><span className="text-ink-muted">IP restrictions</span><span className="badge-neutral">Planned</span></li>
            </ul>
          </div>
          <div className="card-pad">
            <h2 className="panel-title">Recent security events</h2>
            <p className="panel-sub">Sign-ins, failures, role changes, key lifecycle, and settings changes.</p>
            {events.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-ink-faint">No security events recorded yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {events.slice(0, 20).map((log) => (
                  <li key={log.id} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                    <div className="min-w-0">
                      <span className="badge-neutral mr-2">{log.action}</span>
                      <span className="text-ink-muted">{log.actor.email ?? log.actor.uid}</span>
                    </div>
                    <RelativeTime iso={log.createdAt} className="shrink-0 text-xs text-ink-faint" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

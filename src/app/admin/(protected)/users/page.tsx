"use client";

import { useState } from "react";
import { ShieldCheck, UserPlus } from "lucide-react";
import { useSession, useToast, useConfirm } from "@/components/providers";
import { useQuery } from "@/hooks/use-query";
import { Avatar, RelativeTime } from "@/components/ui/data";
import { Dialog, Dropdown } from "@/components/ui/overlays";
import { EmptyState, ErrorState, Spinner, TableSkeleton } from "@/components/ui/feedback";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { Role } from "@/types/auth";

interface ManagedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  disabled: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
}

function RoleBadge({ role }: { role: Role }) {
  if (role === "admin") return <span className="badge-info">Admin</span>;
  if (role === "editor") return <span className="badge-success">Editor</span>;
  return <span className="badge-neutral">Viewer</span>;
}

export default function UsersPage() {
  const { session } = useSession();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refresh } = useQuery<{ users: ManagedUser[] }>("/api/users?limit=100");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [initialPassword, setInitialPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [activity, setActivity] = useState<{ user: ManagedUser; logs: { id: string; action: string; createdAt: string; fileName?: string }[] } | null>(null);

  if (session && session.role !== "admin") {
    return (
      <div className="tbl-wrap">
        <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="Admins only" description="User management requires the administrator role." />
      </div>
    );
  }

  const invite = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await apiFetch<{ user: ManagedUser & { temporaryPassword?: string } }>("/api/users", { method: "POST", body: JSON.stringify({ email, role, password: initialPassword || undefined }) });
      toast(result.user.temporaryPassword ? `User created. Temporary password: ${result.user.temporaryPassword}` : "User created. Share the initial password securely.");
      setInviteOpen(false);
      setEmail("");
      setRole("viewer");
      setInitialPassword("");
      refresh();
    } catch (inviteError) {
      setFormError(inviteError instanceof ClientApiError ? inviteError.message : "Invitation failed.");
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (user: ManagedUser, nextRole: Role) => {
    if (user.uid === session?.uid) {
      toast("You cannot change your own role.", "warning");
      return;
    }
    try {
      await apiFetch(`/api/users/${user.uid}`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
      toast(`Role changed to ${nextRole}.`);
      refresh();
    } catch (roleError) {
      toast(roleError instanceof ClientApiError ? roleError.message : "Role change failed.", "error");
    }
  };

  const resetPassword = async (user: ManagedUser) => {
    const ok = await confirm({ title: "Reset this user password?", description: `${user.email ?? user.uid} will be signed out of every active session.`, confirmLabel: "Reset password", tone: "danger" });
    if (!ok) return;
    try {
      const result = await apiFetch<{ reset: boolean; temporaryPassword?: string }>(`/api/users/${user.uid}/reset-password`, { method: "POST", body: JSON.stringify({}) });
      toast(result.temporaryPassword ? `Password reset. Temporary password: ${result.temporaryPassword}` : "Password reset and all sessions revoked.");
    } catch (resetError) {
      toast(resetError instanceof ClientApiError ? resetError.message : "Password reset failed.", "error");
    }
  };

  const revokeSessions = async (user: ManagedUser) => {
    const ok = await confirm({ title: "Sign out all sessions?", description: `${user.email ?? user.uid} will need to sign in again on every device.`, confirmLabel: "Sign out sessions", tone: "danger" });
    if (!ok) return;
    try {
      const result = await apiFetch<{ revoked: number }>(`/api/users/${user.uid}/sessions`, { method: "DELETE" });
      toast(`${result.revoked} session${result.revoked === 1 ? "" : "s"} revoked.`);
    } catch (revokeError) {
      toast(revokeError instanceof ClientApiError ? revokeError.message : "Session revocation failed.", "error");
    }
  };

  const deleteUser = async (user: ManagedUser) => {
    if (user.uid === session?.uid) return;
    const ok = await confirm({ title: "Delete this user?", description: `${user.email ?? user.uid} will be disabled, soft-deleted, and signed out everywhere.`, confirmLabel: "Delete user", tone: "danger", requireText: "DELETE" });
    if (!ok) return;
    try {
      await apiFetch(`/api/users/${user.uid}`, { method: "DELETE" });
      toast("User deleted.");
      refresh();
    } catch (deleteError) {
      toast(deleteError instanceof ClientApiError ? deleteError.message : "User deletion failed.", "error");
    }
  };

  const viewActivity = async (user: ManagedUser) => {
    try {
      const result = await apiFetch<{ activity: { id: string; action: string; createdAt: string; fileName?: string }[] }>(`/api/users/${user.uid}`);
      setActivity({ user, logs: result.activity });
    } catch (activityError) {
      toast(activityError instanceof ClientApiError ? activityError.message : "Activity could not be loaded.", "error");
    }
  };

  const toggleDisabled = async (user: ManagedUser) => {
    if (user.uid === session?.uid) {
      toast("You cannot disable your own account.", "warning");
      return;
    }
    const ok = await confirm({
      title: user.disabled ? "Re-enable this user?" : "Disable this user?",
      description: user.disabled
        ? `${user.email ?? user.uid} will be able to sign in again.`
        : `${user.email ?? user.uid} will be signed out immediately and blocked from signing in.`,
      confirmLabel: user.disabled ? "Re-enable" : "Disable",
      tone: user.disabled ? "default" : "danger",
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/users/${user.uid}`, { method: "PATCH", body: JSON.stringify({ disabled: !user.disabled }) });
      toast(user.disabled ? "User re-enabled." : "User disabled.");
      refresh();
    } catch (disableError) {
      toast(disableError instanceof ClientApiError ? disableError.message : "Update failed.", "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Users</h1>
          <p className="page-sub">Create local accounts, assign roles, and manage access.</p>
        </div>
        <button type="button" className="btn-primary btn-sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" /> Invite user
        </button>
      </div>

      <div className="card-pad">
        <h2 className="panel-title">Roles</h2>
        <div className="mt-2 grid gap-2 text-[13px] text-ink-muted sm:grid-cols-3">
          <p><span className="font-medium text-ink">Admin</span> — full access, including users, API, settings, and permanent deletion.</p>
          <p><span className="font-medium text-ink">Editor</span> — upload, edit, download, Trash, and restore files.</p>
          <p><span className="font-medium text-ink">Viewer</span> — view, preview, and download only.</p>
        </div>
      </div>

      {loading && <TableSkeleton rows={6} columns={5} />}
      {error && !loading && <div className="tbl-wrap"><ErrorState message={error} onRetry={refresh} /></div>}
      {!loading && !error && (data?.users.length ?? 0) === 0 && (
        <div className="tbl-wrap"><EmptyState title="No users yet" description="Invite your first teammate to get started." /></div>
      )}
      {!loading && !error && (data?.users.length ?? 0) > 0 && (
        <div className="tbl-wrap">
          <div className="overflow-x-auto">
            <table className="tbl min-w-[760px]">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data!.users.map((user) => (
                  <tr key={user.uid}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={user.email} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-ink">{user.displayName || user.email || user.uid}</p>
                          {user.displayName && <p className="truncate font-mono text-[11px] text-ink-faint">{user.email}</p>}
                        </div>
                      </div>
                    </td>
                    <td><RoleBadge role={user.role} /></td>
                    <td>{user.disabled ? <span className="badge-danger">Disabled</span> : <span className="badge-success">Active</span>}</td>
                    <td className="text-[13px] text-ink-muted"><RelativeTime iso={user.lastLoginAt} /></td>
                    <td className="text-right">
                      <Dropdown
                        label={`Actions for ${user.email ?? user.uid}`}
                        trigger={<span role="button" tabIndex={0} className="btn-secondary btn-sm">Manage</span>}
                      >
                        <p className="menu-label">Change role</p>
                        {(["admin", "editor", "viewer"] as Role[]).map((candidate) => (
                          <button
                            key={candidate}
                            type="button"
                            className="menu-item"
                            disabled={candidate === user.role}
                            onClick={() => changeRole(user, candidate)}
                          >
                            {candidate === user.role ? "✓ " : ""}Make {candidate}
                          </button>
                        ))}
                        <div className="menu-sep" />
                        <button type="button" className="menu-item" onClick={() => viewActivity(user)}>View activity</button>
                        <button type="button" className="menu-item" onClick={() => revokeSessions(user)}>Sign out sessions</button>
                        <button type="button" className="menu-item" onClick={() => resetPassword(user)}>Reset password</button>
                        <button type="button" className="menu-item" data-danger={!user.disabled} onClick={() => toggleDisabled(user)}>
                          {user.disabled ? "Re-enable user" : "Disable user"}
                        </button>
                        {user.uid !== session?.uid && <button type="button" className="menu-item" data-danger="true" onClick={() => deleteUser(user)}>Delete user</button>}
                      </Dropdown>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {inviteOpen && (
          <Dialog title="Create user" description="This account signs in directly with email and password. Share the password through a secure channel." onClose={() => setInviteOpen(false)}>
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="invite-email">Email</label>
              <input id="invite-email" type="email" className="field-input" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@organization.org" />
            </div>
            <div>
              <label className="field-label" htmlFor="invite-password">Initial password</label>
              <input id="invite-password" type="password" minLength={12} className="field-input" value={initialPassword} onChange={(event) => setInitialPassword(event.target.value)} placeholder="At least 12 characters (optional)" autoComplete="new-password" />
              <p className="field-hint">Leave blank to generate a one-time temporary password shown after creation.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="invite-role">Role</label>
              <select id="invite-role" className="field-input" value={role} onChange={(event) => setRole(event.target.value as Role)}>
                <option value="viewer">Viewer — view and download</option>
                <option value="editor">Editor — manage files</option>
                <option value="admin">Admin — full access</option>
              </select>
            </div>
            {formError && <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{formError}</p>}
            <div className="flex justify-end gap-2.5">
              <button type="button" className="btn-secondary" onClick={() => setInviteOpen(false)} disabled={busy}>Cancel</button>
              <button type="button" className="btn-primary" onClick={invite} disabled={busy || !email.trim()}>
                {busy && <Spinner />} Send invite
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {activity && (
        <Dialog title={`Activity · ${activity.user.email ?? activity.user.uid}`} description="Recent audit events for this account." onClose={() => setActivity(null)}>
          {activity.logs.length === 0 ? <p className="text-sm text-ink-muted">No activity recorded yet.</p> : <div className="max-h-80 space-y-2 overflow-y-auto">{activity.logs.map((log) => <div key={log.id} className="flex items-start justify-between gap-3 border-b border-line pb-2 text-[13px]"><span className="font-medium text-ink">{log.action}{log.fileName ? ` · ${log.fileName}` : ""}</span><RelativeTime iso={log.createdAt} /></div>)}</div>}
        </Dialog>
      )}
    </div>
  );
}

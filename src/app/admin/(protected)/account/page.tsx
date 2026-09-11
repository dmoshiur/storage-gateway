"use client";

import { useState } from "react";
import { Moon, Sun, Monitor, KeyRound } from "lucide-react";
import { useSession, useTheme, useToast } from "@/components/providers";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { Avatar, RelativeTime } from "@/components/ui/data";
import { useQuery } from "@/hooks/use-query";

export default function AccountPage() {
  const { session } = useSession();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const users = useQuery<{ users: { uid: string; email: string | null; createdAt: string | null; lastLoginAt: string | null }[] }>(
    session?.role === "admin" ? "/api/users?limit=100" : null,
  );
  const me = users.data?.users.find((user) => user.uid === session?.uid);
  const changePassword = async () => {
    setChangingPassword(true);
    try {
      await apiFetch("/api/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      toast("Password changed. Sign in again with the new password.");
    } catch (error) {
      toast(error instanceof ClientApiError ? error.message : "Password change failed.", "error");
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="page-title">Account</h1>
        <p className="page-sub">Your profile, role, and preferences.</p>
      </div>
      <div className="card-pad">
        <div className="flex items-center gap-3.5">
          <Avatar name={session?.email} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-ink">{session?.email ?? "—"}</p>
            <p className="text-[13px] capitalize text-ink-muted">{session?.role} · {session?.uid}</p>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-line border-t border-line">
          <div className="flex justify-between gap-3 py-2.5 text-[13px]">
            <dt className="text-ink-muted">Role</dt>
            <dd className="font-medium capitalize text-ink">{session?.role}</dd>
          </div>
          <div className="flex justify-between gap-3 py-2.5 text-[13px]">
            <dt className="text-ink-muted">Account created</dt>
            <dd className="font-medium text-ink">{me?.createdAt ? <RelativeTime iso={me.createdAt} /> : "—"}</dd>
          </div>
          <div className="flex justify-between gap-3 py-2.5 text-[13px]">
            <dt className="text-ink-muted">Last sign-in</dt>
            <dd className="font-medium text-ink">{me?.lastLoginAt ? <RelativeTime iso={me.lastLoginAt} /> : "—"}</dd>
          </div>
        </dl>
      </div>
      <div className="card-pad">
        <h2 className="panel-title"><KeyRound className="mr-1.5 inline h-4 w-4" />Change password</h2>
        <p className="panel-sub">Changing your password revokes every active session for this account.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div><label className="field-label" htmlFor="current-password">Current password</label><input id="current-password" type="password" className="field-input" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></div>
          <div><label className="field-label" htmlFor="new-password">New password</label><input id="new-password" type="password" minLength={12} className="field-input" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" /></div>
        </div>
        <div className="mt-3 flex justify-end"><button type="button" className="btn-primary" disabled={changingPassword || !currentPassword || newPassword.length < 12} onClick={() => void changePassword()}>{changingPassword ? "Changing…" : "Change password"}</button></div>
      </div>
      <div className="card-pad">
        <h2 className="panel-title">Appearance</h2>
        <p className="panel-sub">Theme preference is saved on this device.</p>
        <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {([
            { value: "light", label: "Light", icon: Sun },
            { value: "dark", label: "Dark", icon: Moon },
            { value: "system", label: "System", icon: Monitor },
          ] as const).map((option) => {
            const Icon = option.icon;
            const active = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(option.value)}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-colors ${active ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900" : "border-line-strong text-ink-muted hover:text-ink"}`}
              >
                <Icon className="h-4 w-4" /> {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="card-pad">
        <h2 className="panel-title">Keyboard shortcuts</h2>
        <ul className="mt-3 space-y-2 text-[13px]">
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Command palette</span><span><span className="kbd">⌘</span> <span className="kbd">K</span></span></li>
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Upload</span><span className="kbd">U</span></li>
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Search</span><span className="kbd">/</span></li>
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Go to Files</span><span><span className="kbd">G</span> <span className="kbd">F</span></span></li>
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Go to Trash</span><span><span className="kbd">G</span> <span className="kbd">T</span></span></li>
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Go to Storage</span><span><span className="kbd">G</span> <span className="kbd">S</span></span></li>
          <li className="flex justify-between gap-3"><span className="text-ink-muted">Close dialog</span><span className="kbd">esc</span></li>
        </ul>
      </div>
    </div>
  );
}

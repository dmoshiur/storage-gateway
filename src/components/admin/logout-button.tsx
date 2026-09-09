"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { signOut } from "firebase/auth";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/client/api";
import { getFirebaseClientAuth } from "@/lib/firebase/client";

export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try { await apiFetch("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }); } catch { /* Server cookie still gets cleared on a later redirect. */ }
    try { await signOut(getFirebaseClientAuth()); } catch { /* Safe when Firebase was not initialized during this visit. */ }
    router.replace("/admin/login");
  }
  return <Button variant="ghost" className={compact ? "h-10 w-10 p-0" : "w-full justify-start"} onClick={logout} disabled={busy} aria-label="Sign out"><LogOut className="h-4 w-4" />{!compact && (busy ? "Signing out…" : "Sign out")}</Button>;
}

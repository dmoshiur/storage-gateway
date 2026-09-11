"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  CircleHelp,
  Command,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  CircleUserRound,
} from "lucide-react";
import { useSession, useTheme, useToast } from "@/components/providers";
import { Dropdown } from "@/components/ui/overlays";
import { Avatar } from "@/components/ui/data";
import { apiFetch } from "@/lib/client/api";
import { breadcrumbFor } from "@/components/shell/nav";
import { usePathname } from "next/navigation";

export function Topbar({ onOpenPalette, onOpenMenu }: { onOpenPalette: () => void; onOpenMenu: () => void }) {
  const { session } = useSession();
  const { theme, setTheme } = useTheme();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ unreadCount: number }>("/api/notifications?limit=1")
      .then((data) => { if (!cancelled) setUnread(data.unreadCount); })
      .catch(() => undefined);
    const timer = setInterval(() => {
      apiFetch<{ unreadCount: number }>("/api/notifications?limit=1")
        .then((data) => { if (!cancelled) setUnread(data.unreadCount); })
        .catch(() => undefined);
    }, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const crumbs = breadcrumbFor(pathname);

  const logout = async () => {
    try {
      // Clear server session first.
      await apiFetch("/api/auth/logout", { method: "POST" });
      // Also sign out from Firebase client to clear local persistence.
      try {
        const { getFirebaseClientAuth } = await import("@/lib/firebase/client");
        const { signOut } = await import("firebase/auth");
        await signOut(getFirebaseClientAuth()).catch(() => undefined);
      } catch {
        // Firebase client sign-out is best-effort; server session is authoritative.
      }
    } catch {
      toast("Sign-out failed. Please try again.", "error");
      return;
    }
    router.push("/admin/login");
    router.refresh();
  };

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface-raised/95">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
        <button type="button" aria-label="Open navigation" onClick={onOpenMenu} className="btn-icon lg:hidden">
          <Menu className="h-5 w-5" />
        </button>
        <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-[13px] md:flex">
          {crumbs.map((crumb, index) => (
            <span key={crumb.href} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && <span className="text-ink-faint">/</span>}
              <Link href={crumb.href} className={index === crumbs.length - 1 ? "truncate font-medium text-ink" : "shrink-0 text-ink-muted hover:text-ink"}>
                {crumb.label}
              </Link>
            </span>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Open command palette"
          className="hidden h-9 w-64 items-center gap-2 rounded-lg border border-line-strong bg-surface-sunken px-3 text-[13px] text-ink-faint transition-colors hover:border-slate-400 hover:text-ink-muted sm:flex lg:w-72"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search or command…</span>
          <span className="flex items-center gap-0.5">
            <span className="kbd"><Command className="h-3 w-3" /></span>
            <span className="kbd">K</span>
          </span>
        </button>
        <button type="button" aria-label="Open command palette" onClick={onOpenPalette} className="btn-icon sm:hidden">
          <Search className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="btn-icon"
        >
          {theme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
        <Link href="/admin/notifications" aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`} className="btn-icon relative">
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Link>
        <Dropdown
          label="Help"
          trigger={
            <span className="btn-icon" role="button" tabIndex={0} aria-label="Help">
              <CircleHelp className="h-[18px] w-[18px]" />
            </span>
          }
        >
          <p className="menu-label">Help</p>
          <Link href="/admin/api?tab=docs" className="menu-item">API documentation</Link>
          <button type="button" className="menu-item" onClick={onOpenPalette}>Keyboard shortcuts</button>
          <Link href="/admin/system" className="menu-item">System status</Link>
        </Dropdown>
        <Dropdown
          label="Account"
          trigger={
            <span role="button" tabIndex={0} aria-label="Account menu" className="flex items-center gap-2 rounded-lg p-1 hover:bg-slate-500/10">
              <Avatar name={session?.email} size="sm" />
            </span>
          }
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-[13px] font-medium text-ink">{session?.email ?? "—"}</p>
            <p className="text-xs capitalize text-ink-faint">{session?.role ?? ""}</p>
          </div>
          <div className="menu-sep" />
          <Link href="/admin/account" className="menu-item"><CircleUserRound className="h-4 w-4" /> Account settings</Link>
          {session?.role === "admin" && (
            <Link href="/admin/settings" className="menu-item"><Settings className="h-4 w-4" /> System settings</Link>
          )}
          <div className="menu-sep" />
          <button type="button" onClick={logout} className="menu-item" data-danger="true"><LogOut className="h-4 w-4" /> Sign out</button>
        </Dropdown>
      </div>
    </header>
  );
}

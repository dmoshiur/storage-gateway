"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Archive, ClipboardList, FileText, HardDrive, LayoutDashboard, Menu, Settings, ShieldCheck, X } from "lucide-react";
import { classNames } from "@/utils/format";
import { LogoutButton } from "@/components/admin/logout-button";
import { Button } from "@/components/ui/button";

const links = [
  { href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/files", label: "Files", icon: FileText },
  { href: "/admin/trash", label: "Trash", icon: Archive },
  { href: "/admin/storage", label: "Storage", icon: HardDrive },
  { href: "/admin/audit-logs", label: "Audit logs", icon: ClipboardList },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

function Navigation({ close }: { close?: () => void }) {
  const path = usePathname();
  return <nav className="space-y-1" aria-label="Storage administration">
    {links.map(({ href, label, icon: Icon }) => {
      const selected = path === href;
      return <Link key={href} href={href} onClick={close} aria-current={selected ? "page" : undefined} className={classNames("flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition", selected ? "bg-ngo-50 text-ngo-700" : "text-slate-600 hover:bg-slate-100 hover:text-ink-900")}><Icon className="h-4.5 w-4.5" aria-hidden="true" />{label}</Link>;
    })}
  </nav>;
}

export function AdminShell({ children, actorEmail }: { children: React.ReactNode; actorEmail: string | null }) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    const onSessionExpired = () => router.replace("/admin/login");
    window.addEventListener("gateway-session-expired", onSessionExpired);
    return () => window.removeEventListener("gateway-session-expired", onSessionExpired);
  }, [router]);
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16.5rem_1fr]">
      <aside className="hidden border-r border-slate-200 bg-white p-4 lg:fixed lg:inset-y-0 lg:flex lg:w-[16.5rem] lg:flex-col">
        <div className="flex items-center gap-2.5 px-2 py-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-ngo-600 text-white"><FileText className="h-5 w-5" /></span><span><strong className="block text-sm text-ink-900">NGO PDF Storage</strong><span className="text-xs text-slate-500">Private gateway</span></span></div>
        <div className="mt-7"><Navigation /></div>
        <div className="mt-auto border-t border-slate-200 pt-4"><p className="mb-2 truncate px-3 text-xs text-slate-500" title={actorEmail ?? undefined}>{actorEmail ?? "Administrator"}</p><LogoutButton /></div>
      </aside>

      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:hidden"><Link href="/admin/dashboard" className="flex items-center gap-2 font-bold text-ink-900"><span className="grid h-8 w-8 place-items-center rounded-lg bg-ngo-600 text-white"><FileText className="h-4 w-4" /></span>NGO PDF Storage</Link><Button variant="ghost" className="h-10 w-10 p-0" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></Button></header>
      {mobileOpen && <div className="fixed inset-0 z-50 bg-slate-950/40 lg:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) setMobileOpen(false); }}><aside className="flex h-full w-72 flex-col bg-white p-4 shadow-2xl"><div className="flex items-center justify-between"><span className="flex items-center gap-2 font-bold text-ink-900"><ShieldCheck className="h-5 w-5 text-ngo-600" />Storage navigation</span><Button variant="ghost" className="h-10 w-10 p-0" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X className="h-5 w-5" /></Button></div><div className="mt-6"><Navigation close={() => setMobileOpen(false)} /></div><div className="mt-auto border-t border-slate-200 pt-4"><p className="mb-2 truncate px-3 text-xs text-slate-500">{actorEmail ?? "Administrator"}</p><LogoutButton /></div></aside></div>}
      <main className="min-w-0 p-4 sm:p-6 lg:col-start-2 lg:p-8">{children}</main>
    </div>
  );
}

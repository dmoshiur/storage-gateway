"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useSession } from "@/components/providers";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { CommandPalette } from "@/components/shell/command-palette";
import { UploadModal } from "@/components/files/upload-modal";
import { PageSkeleton } from "@/components/ui/feedback";

export function AdminShell({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => {
    if (!loading && !session) router.replace(`/admin/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, session, router, pathname]);

  // Close the mobile drawer on navigation (render-adjust, not an effect).
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setMobileOpen(false);
  }

  const openUpload = useCallback(() => setUploadOpen(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (typing || paletteOpen || uploadOpen) return;
      if (event.key === "u" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setUploadOpen(true);
      } else if (event.key === "/") {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.key.toLowerCase() === "g") {
        const follow = (followEvent: KeyboardEvent) => {
          document.removeEventListener("keydown", follow, true);
          const key = followEvent.key.toLowerCase();
          const map: Record<string, string> = {
            f: "/admin/files",
            t: "/admin/trash",
            s: "/admin/storage",
            o: "/admin/overview",
            r: "/admin/recent",
          };
          if (map[key]) {
            followEvent.preventDefault();
            router.push(map[key]!);
          }
        };
        document.addEventListener("keydown", follow, true);
        window.setTimeout(() => document.removeEventListener("keydown", follow, true), 1200);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router, paletteOpen, uploadOpen]);

  useEffect(() => {
    const onUpload = () => setUploadOpen(true);
    window.addEventListener("nfc:upload", onUpload);
    return () => window.removeEventListener("nfc:upload", onUpload);
  }, []);

  if (loading || !session) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <PageSkeleton />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* desktop sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 hidden border-r border-line bg-surface-raised transition-all lg:block ${collapsed ? "w-[68px]" : "w-60"}`}>
        <Sidebar role={session.role} collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
      </aside>
      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[75] lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="overlay" onClick={() => setMobileOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-[76] w-72 border-r border-line bg-surface-raised animate-fade-in">
            <button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="btn-icon absolute right-2 top-3">
              <X className="h-5 w-5" />
            </button>
            <Sidebar role={session.role} collapsed={false} onToggle={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className={`flex min-h-screen flex-col transition-all ${collapsed ? "lg:pl-[68px]" : "lg:pl-60"}`}>
        <Topbar onOpenPalette={() => setPaletteOpen(true)} onOpenMenu={() => setMobileOpen(true)} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-5 sm:px-5 sm:py-6">{children}</main>
        <footer className="border-t border-line py-4">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-1 px-3 text-xs text-ink-faint sm:px-5">
            <span className="font-medium text-ink-muted">NGO File Cloud v1.0.0</span>
            <span>Private document storage</span>
            <span className="ml-auto font-mono">press <span className="kbd">⌘K</span> for commands</span>
          </div>
        </footer>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onUpload={openUpload} />
      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
    </div>
  );
}

export function openUploadModal() {
  window.dispatchEvent(new Event("nfc:upload"));
}

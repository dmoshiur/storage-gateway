"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock3,
  Files,
  LayoutDashboard,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  Users,
  KeyRound,
  Warehouse,
  FileText,
} from "lucide-react";
import { useSession, useTheme } from "@/components/providers";
import { useOverlayBehavior } from "@/components/ui/overlays";
import { apiFetch } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  icon: typeof Files;
  run: () => void;
}

export function CommandPalette({ open, onClose, onUpload }: { open: boolean; onClose: () => void; onUpload: () => void }) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { session } = useSession();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<SerializedFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useOverlayBehavior({ onClose, active: open });

  const go = (href: string) => {
    onClose();
    setQuery("");
    router.push(href);
  };

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "upload", label: "Upload PDF", hint: "U", keywords: "upload add new pdf document", icon: Upload, run: () => { onClose(); onUpload(); } },
      { id: "dash", label: "Open dashboard", keywords: "dashboard overview home stats", icon: LayoutDashboard, run: () => go("/admin/overview") },
      { id: "files", label: "Open all files", hint: "G F", keywords: "files documents list browse", icon: Files, run: () => go("/admin/files") },
      { id: "recent", label: "View recent files", keywords: "recent latest new", icon: Clock3, run: () => go("/admin/recent") },
      { id: "trash", label: "Open trash", hint: "G T", keywords: "trash deleted restore", icon: Trash2, run: () => go("/admin/trash") },
      { id: "storage", label: "Open storage", hint: "G S", keywords: "storage usage analytics quota", icon: Warehouse, run: () => go("/admin/storage") },
      { id: "theme", label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode", keywords: "theme dark light mode appearance", icon: theme === "dark" ? Sun : Moon, run: () => { setTheme(theme === "dark" ? "light" : "dark"); onClose(); } },
    ];
    if (session?.role === "admin") {
      list.push(
        { id: "users", label: "Manage users", keywords: "users roles invite team", icon: Users, run: () => go("/admin/users") },
        { id: "api", label: "Open API management", keywords: "api keys integration developer docs", icon: KeyRound, run: () => go("/admin/api") },
        { id: "audit", label: "Open audit logs", keywords: "audit logs security history", icon: ScrollText, run: () => go("/admin/audit") },
        { id: "settings", label: "Open settings", keywords: "settings configuration retention", icon: Settings, run: () => go("/admin/settings") },
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, session?.role]);

  const needle = query.trim().toLowerCase();
  const matchedCommands = commands.filter((command) =>
    !needle || command.label.toLowerCase().includes(needle) || command.keywords.includes(needle),
  );
  // Stale results are masked instead of cleared, so no effect needs setState.
  const visibleFiles = open && needle.length >= 2 ? files : [];

  // Reset on open (render-adjust, not an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!open || needle.length < 2) return;
    const timer = setTimeout(() => {
      apiFetch<{ files: SerializedFile[] }>(`/api/files?pageSize=5&status=active&filter=active&sort=newest&search=${encodeURIComponent(needle)}`)
        .then((data) => setFiles(data.files))
        .catch(() => setFiles([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [needle, open]);

  if (!open) return null;

  const total = matchedCommands.length + visibleFiles.length;

  const runIndex = (i: number) => {
    if (i < matchedCommands.length) matchedCommands[i]!.run();
    else {
      const file = visibleFiles[i - matchedCommands.length];
      if (file) go(`/admin/files?preview=${file.id}`);
    }
  };

  return (
    <div className="fixed inset-0 z-[85] px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="overlay" onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} className="card relative z-10 mx-auto w-full max-w-xl overflow-hidden shadow-pop animate-slide-up dark:shadow-popdark">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(total - 1, i + 1)); }
              else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (event.key === "Enter") { event.preventDefault(); runIndex(index); }
              else if (event.key === "Escape") onClose();
            }}
            placeholder="Type a command or search files…"
            aria-label="Type a command or search files"
            className="h-12 w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="max-h-[320px] overflow-y-auto p-2">
          {matchedCommands.length === 0 && visibleFiles.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-ink-faint">No matching commands or files.</p>
          )}
          {matchedCommands.map((command, i) => {
            const Icon = command.icon;
            return (
              <button
                key={command.id}
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => runIndex(i)}
                className={`menu-item ${i === index ? "bg-slate-500/10" : ""}`}
              >
                <Icon className="h-4 w-4 text-ink-faint" />
                <span className="flex-1 text-left">{command.label}</span>
                {command.hint && <span className="kbd">{command.hint}</span>}
              </button>
            );
          })}
          {visibleFiles.length > 0 && (
            <>
              <p className="menu-label">Files</p>
              {visibleFiles.map((file, j) => {
                const i = matchedCommands.length + j;
                return (
                  <button
                    key={file.id}
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => runIndex(i)}
                    className={`menu-item ${i === index ? "bg-slate-500/10" : ""}`}
                  >
                    <FileText className="h-4 w-4 text-ink-faint" />
                    <span className="flex-1 truncate text-left">{file.title || file.originalName}</span>
                    <span className="font-mono text-[11px] text-ink-faint">{file.extension.toUpperCase()}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-line bg-surface-sunken px-4 py-2 text-[11px] text-ink-faint">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↵</span> select</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}

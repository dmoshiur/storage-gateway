"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, LoaderCircle, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { useToast } from "@/components/providers";
import { useOverlayBehavior } from "@/components/ui/overlays";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { displayName } from "@/components/files/file-helpers";

export function PdfViewer({ file, onClose }: { file: SerializedFile; onClose: () => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [frameKey, setFrameKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ url: string; expiresAt: string }>(`/api/files/${file.id}/preview`);
      setUrl(data.url);
      setExpiresAt(data.expiresAt);
    } catch (fetchError) {
      setError(fetchError instanceof ClientApiError ? fetchError.message : "Preview could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [file.id]);

  useEffect(() => {
    // Deferred so state updates never run synchronously inside the effect.
    void Promise.resolve().then(() => load());
  }, [load]);

  const panelRef = useOverlayBehavior({ onClose });

  // Refresh the signed URL a minute before it expires so long reads never break.
  useEffect(() => {
    if (!expiresAt) return;
    const ms = new Date(expiresAt).getTime() - Date.now() - 60000;
    if (ms <= 0) return;
    const timer = setTimeout(() => void load(), ms);
    return () => clearTimeout(timer);
  }, [expiresAt, load]);

  const download = async () => {
    try {
      const data = await apiFetch<{ url: string }>(`/api/files/${file.id}/download`);
      const link = document.createElement("a");
      link.href = data.url;
      link.download = file.originalName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      toast("Download failed.", "error");
    }
  };

  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={`Preview ${displayName(file)}`}>
      <div className="overlay" onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} className={`absolute bg-surface-raised shadow-pop animate-slide-up dark:shadow-popdark ${fullscreen ? "inset-0" : "inset-2 rounded-xl border border-line sm:inset-4 lg:inset-x-10 lg:inset-y-6"}`}>
        <div className="flex h-full flex-col overflow-hidden rounded-xl">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-ink">{displayName(file)}</h2>
              <p className="truncate font-mono text-[11px] text-ink-faint">{file.originalName}</p>
            </div>
            <button type="button" onClick={() => { setFrameKey((key) => key + 1); void load(); }} aria-label="Reload preview" title="Reload preview" className="btn-icon">
              <RotateCw className="h-4 w-4" />
            </button>
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" title="Open in new tab" className="btn-icon">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button type="button" onClick={download} aria-label="Download" title="Download" className="btn-icon">
              <Download className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setFullscreen((value) => !value)}
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              className="btn-icon"
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button type="button" onClick={onClose} aria-label="Close preview" className="btn-icon">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="relative flex-1 bg-slate-500/10">
            {loading && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                  <LoaderCircle className="h-5 w-5 animate-spin" /> Loading secure preview…
                </div>
              </div>
            )}
            {error && !loading && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center">
                <div>
                  <p className="text-sm font-medium text-ink">Preview unavailable</p>
                  <p className="mt-1 text-[13px] text-ink-muted">{error}</p>
                  <button type="button" onClick={() => void load()} className="btn-secondary mt-4">Try again</button>
                </div>
              </div>
            )}
            {url && !error && (
              <iframe
                key={frameKey}
                src={url}
                title={`Preview of ${displayName(file)}`}
                onLoad={() => setLoading(false)}
                className="h-full w-full border-0 bg-white"
                allow="fullscreen"
              />
            )}
          </div>
          <div className="flex h-9 shrink-0 items-center justify-between border-t border-line px-3 sm:px-4">
            <p className="font-mono text-[11px] text-ink-faint">Private preview · temporary authorized access</p>
            <p className="hidden font-mono text-[11px] text-ink-faint sm:block">Use the viewer toolbar to zoom, navigate pages, and print</p>
          </div>
        </div>
      </div>
    </div>
  );
}

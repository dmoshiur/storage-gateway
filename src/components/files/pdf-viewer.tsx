"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, LoaderCircle, Maximize2, Minimize2, RotateCw, X } from "lucide-react";
import { useToast } from "@/components/providers";
import { useOverlayBehavior } from "@/components/ui/overlays";
import { apiErrorOptions, ClientApiError } from "@/lib/client/api";
import { fetchStreamedFile, saveBlobAsFile } from "@/lib/client/download";
import type { SerializedFile } from "@/types/file";
import { displayName } from "@/components/files/file-helpers";

/** Appends the real backend cause when the API reported one. */
function describeFailure(error: unknown, fallback: string): string {
  const options = apiErrorOptions(error, fallback);
  const cause = error instanceof ClientApiError ? error.causeMessage : null;
  return cause ? `${options.message} (${cause})` : options.message;
}

export function PdfViewer({ file, onClose }: { file: SerializedFile; onClose: () => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [frameLoading, setFrameLoading] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const loadBusyRef = useRef(false);
  const downloadBusyRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    // The reload control, expiry timer, and retry button can all race. Keep
    // one preview request per viewer and let the iframe remain local to the
    // viewer rather than blocking the Files page.
    if (loadBusyRef.current) return;
    loadBusyRef.current = true;
    setTokenLoading(true);
    setFrameLoading(true);
    setError(null);
    releaseObjectUrl();
    setUrl(null);
    try {
      // The PDF is streamed through our own authenticated route: Firebase
      // session verified server-side, role authorized, metadata read from
      // Firestore, bytes fetched from the private Blob store. The browser only
      // ever sees a local blob: URL for rendering.
      const blob = await fetchStreamedFile(`/api/files/${file.id}/preview?stream=true`);
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      // Streamed previews carry no link lifetime, so there is nothing to renew.
      setUrl(objectUrl);
    } catch (fetchError) {
      setError(describeFailure(fetchError, "Preview could not be loaded. Try again."));
      setFrameLoading(false);
    } finally {
      loadBusyRef.current = false;
      setTokenLoading(false);
    }
  }, [file.id, releaseObjectUrl]);

  // Never leak the object URL when the viewer closes.
  useEffect(() => releaseObjectUrl, [releaseObjectUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const panelRef = useOverlayBehavior({ onClose });

  const download = async () => {
    if (downloadBusyRef.current) return;
    downloadBusyRef.current = true;
    setDownloadBusy(true);
    try {
      // Served through the authenticated route, so no Blob URL is exposed.
      const blob = await fetchStreamedFile(`/api/files/${file.id}/download?stream=true`);
      saveBlobAsFile(blob, file.originalName);
      toast("Download started.");
    } catch (downloadError) {
      const options = apiErrorOptions(downloadError, "Download failed. Try again.");
      toast(options.message, "error", { requestId: options.requestId, retry: () => void download() });
    } finally {
      downloadBusyRef.current = false;
      setDownloadBusy(false);
    }
  };

  const loading = tokenLoading || frameLoading;

  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={`Preview ${displayName(file)}`}>
      <div className="overlay" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} className={`absolute z-10 bg-surface-raised shadow-pop animate-slide-up dark:shadow-popdark ${fullscreen ? "inset-0" : "inset-2 rounded-xl border border-line sm:inset-4 lg:inset-x-10 lg:inset-y-6"}`}>
        <div className="flex h-full flex-col overflow-hidden rounded-xl">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-ink">{displayName(file)}</h2>
              <p className="truncate font-mono text-[11px] text-ink-faint">{file.originalName}</p>
            </div>
            <button
              type="button"
              onClick={() => { setFrameKey((key) => key + 1); void load(); }}
              disabled={loading}
              aria-busy={loading}
              aria-label="Reload preview"
              title="Reload preview"
              className="btn-icon"
            >
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
            </button>
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" title="Open in new tab" className="btn-icon">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <button type="button" onClick={() => void download()} disabled={downloadBusy} aria-busy={downloadBusy} aria-label="Download" title="Download" className="btn-icon">
              {downloadBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
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
              <div className="absolute inset-0 z-10 grid place-items-center bg-surface-raised/60">
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
                onLoad={() => setFrameLoading(false)}
                onError={() => { setFrameLoading(false); setError("The secure preview could not be displayed."); }}
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

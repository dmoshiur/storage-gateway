"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, UploadCloud, X, XCircle } from "lucide-react";
import { useToast } from "@/components/providers";
import { Dialog } from "@/components/ui/overlays";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import type { SerializedFile } from "@/types/file";
import { formatBytes } from "@/utils/format";

type ItemStatus = "queued" | "hashing" | "authorizing" | "uploading" | "finalizing" | "done" | "error";

interface QueueItem {
  key: string;
  file: File;
  status: ItemStatus;
  progress: number;
  error: string | null;
  duplicateOf: { id: string; originalName: string } | null;
  fileId: string | null;
}

const ACCEPT = ".pdf,.doc,.docx,.txt,.ppt,.pptx,application/pdf";

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function putWithProgress(url: string, file: File, contentType: string, onProgress: (percent: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}.`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export function UploadModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [category, setCategory] = useState("");
  const running = useRef(false);
  const aborters = useRef(new Map<string, AbortController>());
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((key: string, update: Partial<QueueItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...update } : item)));
  }, []);

  const processItem = useCallback(async (item: QueueItem) => {
    const controller = new AbortController();
    aborters.current.set(item.key, controller);
    try {
      patch(item.key, { status: "hashing", error: null });
      const contentHash = await sha256Hex(item.file).catch(() => null);
      if (controller.signal.aborted) return;
      patch(item.key, { status: "authorizing" });
      const init = await apiFetch<{
        file: SerializedFile;
        uploadUrl: string;
        uploadHeaders: Record<string, string>;
        duplicateOf: { id: string; originalName: string } | null;
      }>("/api/files/upload/init", {
        method: "POST",
        body: JSON.stringify({
          originalName: item.file.name,
          size: item.file.size,
          mimeType: item.file.type || undefined,
          category,
          ...(contentHash ? { contentHash } : {}),
        }),
      });
      if (controller.signal.aborted) return;
      patch(item.key, { status: "uploading", progress: 0, duplicateOf: init.duplicateOf, fileId: init.file.id });
      await putWithProgress(
        init.uploadUrl,
        item.file,
        init.uploadHeaders["Content-Type"] ?? item.file.type ?? "application/pdf",
        (progress) => patch(item.key, { progress }),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      patch(item.key, { status: "finalizing", progress: 100 });
      const completed = await apiFetch<{ file: SerializedFile; duplicateOf: { id: string; originalName: string } | null }>(
        `/api/files/${init.file.id}/complete`,
        { method: "POST", body: JSON.stringify(contentHash ? { contentHash } : {}) },
      );
      patch(item.key, { status: "done", progress: 100, duplicateOf: completed.duplicateOf ?? init.duplicateOf });
    } catch (error) {
      if (controller.signal.aborted) {
        patch(item.key, { status: "error", error: "Upload cancelled." });
        return;
      }
      patch(item.key, {
        status: "error",
        error: error instanceof ClientApiError ? error.message : error instanceof Error ? error.message : "Upload failed.",
      });
    } finally {
      aborters.current.delete(item.key);
    }
  }, [patch, category]);

  useEffect(() => {
    if (running.current) return;
    const next = items.find((item) => item.status === "queued");
    if (!next) return;
    running.current = true;
    // Deferred so state updates never run synchronously inside the effect.
    void Promise.resolve()
      .then(() => processItem(next))
      .finally(() => {
        running.current = false;
      });
  }, [items, processItem]);

  const addFiles = (files: FileList | File[]) => {
    const list = [...files].filter((file) => file.size > 0).slice(0, 10);
    if (list.length === 0) return;
    setItems((current) => [
      ...current,
      ...list.map((file, index) => ({
        key: `${Date.now()}-${index}-${file.name}`,
        file,
        status: "queued" as ItemStatus,
        progress: 0,
        error: null,
        duplicateOf: null,
        fileId: null,
      })),
    ]);
  };

  const cancel = (key: string) => {
    aborters.current.get(key)?.abort();
    setItems((current) => current.filter((item) => item.key !== key));
  };

  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error").length;
  const busy = items.some((item) => !["done", "error"].includes(item.status));

  const close = () => {
    if (busy) {
      toast("Uploads are still in progress. They will be cancelled.", "warning");
      for (const controller of aborters.current.values()) controller.abort();
    }
    if (done > 0) window.dispatchEvent(new Event("nfc:files-changed"));
    onClose();
  };

  return (
    <Dialog title="Upload documents" description="Files stream directly to private storage. PDF, DOC, DOCX, TXT, PPT, PPTX up to the configured limit." onClose={close} wide>
      <div className="space-y-4">
        <div>
          <label className="field-label" htmlFor="upload-category">Category (applies to new uploads)</label>
          <input id="upload-category" className="field-input" value={category} maxLength={80} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Reports" />
        </div>
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose files to upload"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => { if (event.key === "Enter") inputRef.current?.click(); }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
          className={`grid cursor-pointer place-items-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${dragging ? "border-blue-500 bg-blue-500/5" : "border-line-strong hover:border-slate-400"}`}
        >
          <UploadCloud className="h-8 w-8 text-ink-faint" />
          <p className="mt-2 text-sm font-medium text-ink">Drop files here or click to browse</p>
          <p className="mt-0.5 text-xs text-ink-muted">Up to 10 files at a time · direct-to-storage upload</p>
          <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
        </div>

        {items.length > 0 && (
          <ul className="max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
            {items.map((item) => (
              <li key={item.key} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2.5">
                  <FileUp className="h-4 w-4 shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink">{item.file.name}</p>
                    <p className="tnum text-xs text-ink-faint">{formatBytes(item.file.size)}</p>
                  </div>
                  {item.status === "done" && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />}
                  {item.status === "error" && <XCircle className="h-4 w-4 shrink-0 text-red-500" />}
                  {(item.status === "hashing" || item.status === "authorizing" || item.status === "finalizing") && (
                    <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-ink-muted" />
                  )}
                  {item.status !== "done" && (
                    <button type="button" aria-label={`Remove ${item.file.name}`} onClick={() => cancel(item.key)} className="btn-icon h-7 w-7">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {(item.status === "uploading" || item.status === "finalizing") && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-500/15" role="progressbar" aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                )}
                <p className="mt-1 text-xs text-ink-muted">
                  {item.status === "queued" && "Queued"}
                  {item.status === "hashing" && "Checking for duplicates…"}
                  {item.status === "authorizing" && "Authorizing upload…"}
                  {item.status === "uploading" && `Uploading… ${item.progress}%`}
                  {item.status === "finalizing" && "Verifying document…"}
                  {item.status === "done" && "Uploaded and verified."}
                  {item.status === "error" && <span className="text-red-600 dark:text-red-400">{item.error}</span>}
                </p>
                {item.duplicateOf && item.status === "done" && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Identical content already exists as “{item.duplicateOf.originalName}”. The new copy was kept.</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink-muted">
            {items.length === 0 ? "No files selected." : `${done} completed · ${failed} failed · ${items.length - done - failed} pending`}
          </p>
          <button type="button" className="btn-secondary" onClick={close}>{busy ? "Cancel all" : "Close"}</button>
        </div>
      </div>
    </Dialog>
  );
}

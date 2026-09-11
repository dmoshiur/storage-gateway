"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, UploadCloud, X, XCircle } from "lucide-react";
import { uploadPresigned } from "@vercel/blob/client";
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
  /** SHA-256 of the bytes, kept so a finalize retry sends the same value. */
  contentHash: string | null;
  /**
   * The bytes are safely in private Blob but the Firestore metadata write
   * failed. Retrying must re-run finalization only — re-uploading would create
   * a second orphaned object.
   */
  orphaned: boolean;
}

const ACCEPT = ".pdf,.doc,.docx,.txt,.ppt,.pptx,application/pdf";
const SUPPORTED_NAME = /\.(pdf|doc|docx|txt|ppt|pptx)$/i;

/**
 * Guard rails that make a wedged upload impossible.
 *
 * The @vercel/blob client has NO built-in timeouts and its token fetch ignores
 * `abortSignal`; on failure it retries 10x with exponential backoff (~17 min).
 * That combination is what produced the "Uploading… 0%" forever hang. We
 * therefore race the SDK promise against three guards:
 *   - stall watchdog: no progress callback for 45s -> abort + fail
 *   - hard deadline : 10 minutes total -> abort + fail
 *   - CSP detector  : browser reports connect-src blocking of the Blob API
 *                     -> abort + fail immediately with an actionable message
 */
const UPLOAD_STALL_MS = 45_000;
const UPLOAD_HARD_TIMEOUT_MS = 10 * 60_000;
const WATCHDOG_POLL_MS = 5_000;
const BLOB_API_PATTERN = /vercel\.com|blob\.vercel-storage\.com/;

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Maps any failure to a message a human can act on — never a silent hang. */
function uploadErrorMessage(error: unknown): string {
  if (error instanceof ClientApiError) return error.message;
  const raw = error instanceof Error ? error.message : String(error);
  if (/aborted|cancelled/i.test(raw)) return "Upload cancelled.";
  if (raw.includes("Failed to retrieve the presigned URL")) {
    return "The server could not issue an upload token (/api/blob/upload). Check the server logs and the Blob store configuration, then retry.";
  }
  if (/Failed to fetch|Network request failed|network error|Load failed/i.test(raw)) {
    return "The direct upload to Vercel Blob was blocked by the browser or network. Ensure connect-src allows https://vercel.com in the Content-Security-Policy and that vercel.com is reachable.";
  }
  return raw || "Upload failed.";
}

interface GuardedUploadParams {
  file: File;
  pathname: string;
  clientPayload: string;
  controller: AbortController;
  onProgress: (percentage: number) => void;
}

/**
 * Runs `uploadPresigned` with stall/hard-timeout/CSP guards.
 * The returned promise ALWAYS settles within the guard bounds.
 */
async function uploadPresignedGuarded(params: GuardedUploadParams): Promise<void> {
  const { controller } = params;
  let lastActivityAt = Date.now();
  let cspBlockedUrl: string | null = null;

  const onViolation = (event: SecurityPolicyViolationEvent) => {
    if (event.effectiveDirective === "connect-src" && BLOB_API_PATTERN.test(event.blockedURI)) {
      cspBlockedUrl = event.blockedURI;
      controller.abort(); // stop the SDK's silent retry loop immediately
    }
  };

  let pollId = 0;
  let hardTimerId = 0;
  document.addEventListener("securitypolicyviolation", onViolation);
  try {
    const work = uploadPresigned(params.pathname, params.file, {
      access: "private",
      handleUploadUrl: "/api/blob/upload",
      clientPayload: params.clientPayload,
      abortSignal: controller.signal,
      onUploadProgress: ({ percentage }) => {
        lastActivityAt = Date.now();
        params.onProgress(Math.round(percentage));
      },
    });

    // Rejects from the first guard that trips; cleared when `work` settles.
    const guards = new Promise<never>((_, reject) => {
      pollId = window.setInterval(() => {
        if (cspBlockedUrl) {
          controller.abort();
          reject(
            new Error(
              `Upload blocked by the browser Content-Security-Policy (${cspBlockedUrl}). Add the Vercel Blob API host to connect-src in next.config.ts.`,
            ),
          );
          return;
        }
        if (Date.now() - lastActivityAt > UPLOAD_STALL_MS) {
          controller.abort();
          reject(new Error(`Upload stalled: no progress for ${Math.round(UPLOAD_STALL_MS / 1000)} seconds. Check your connection and retry.`));
        }
      }, WATCHDOG_POLL_MS);
      hardTimerId = window.setTimeout(() => {
        controller.abort();
        reject(new Error("Upload timed out. Please retry with a smaller file or a more stable connection."));
      }, UPLOAD_HARD_TIMEOUT_MS);
    });

    await Promise.race([work, guards]);
    // `work` won: the PUT succeeded (or threw) within the guard bounds.
  } finally {
    window.clearInterval(pollId);
    window.clearTimeout(hardTimerId);
    document.removeEventListener("securitypolicyviolation", onViolation);
  }
}

/**
 * OIDC-compatible direct-to-storage upload (fixed flow):
 *  1. POST /api/files/upload/init — creates the Firestore file record and
 *     returns the storage pathname (pdfs/YYYY/MM/<uuid>.ext).
 *  2. uploadPresigned(pathname, file) — POSTs /api/blob/upload, which signs a
 *     put-scoped delegation with `issueSignedToken` (works with OIDC
 *     BLOB_STORE_ID + VERCEL_OIDC_TOKEN or a static read-write token), then
 *     PUTs the bytes straight to https://vercel.com/api/blob. The browser
 *     must be allowed to reach that host (CSP connect-src).
 *  3. POST /api/files/[id]/complete — server-side PDF header/trailer
 *     validation and activation.
 */

export function UploadModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [category, setCategory] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeStartRef = useRef<string | null>(null);
  const aborters = useRef(new Map<string, AbortController>());
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((key: string, update: Partial<QueueItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...update } : item)));
  }, []);

  /**
   * Re-runs only the metadata finalization for an orphaned upload: the PDF is
   * already in the private Blob store, so re-uploading would create a second
   * copy while the first one waits for cleanup.
   */
  const finalizeOrphan = useCallback(async (item: QueueItem): Promise<void> => {
    const fileId = item.fileId;
    if (!fileId) return;
    const controller = new AbortController();
    aborters.current.set(item.key, controller);
    try {
      patch(item.key, { status: "finalizing", progress: 100, error: null });
      const completed = await apiFetch<{ file: SerializedFile; duplicateOf: { id: string; originalName: string } | null }>(
        `/api/files/${fileId}/complete`,
        {
          method: "POST",
          body: JSON.stringify(item.contentHash ? { contentHash: item.contentHash } : {}),
          signal: controller.signal,
        },
      );
      patch(item.key, {
        status: "done",
        progress: 100,
        orphaned: false,
        duplicateOf: completed.duplicateOf ?? item.duplicateOf,
      });
      // A finalized document must show up in the list immediately.
      window.dispatchEvent(new Event("nfc:files-changed"));
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        patch(item.key, { status: "error", error: "Finalize cancelled. The stored document is kept for retry." });
        return;
      }
      patch(item.key, { status: "error", error: uploadErrorMessage(error), orphaned: true });
    } finally {
      aborters.current.delete(item.key);
    }
  }, [patch]);

  const processItem = useCallback(async (item: QueueItem) => {
    // A retry of an orphaned upload finishes the metadata only.
    if (item.orphaned && item.fileId) return finalizeOrphan(item);
    const controller = new AbortController();
    aborters.current.set(item.key, controller);
    try {
      patch(item.key, { status: "hashing", error: null });
      const contentHash = await sha256Hex(item.file).catch(() => null);
      if (controller.signal.aborted) return;

      patch(item.key, { status: "authorizing" });
      const init = await apiFetch<{
        file: SerializedFile;
        pathname: string;
        duplicateOf: { id: string; originalName: string } | null;
      }>("/api/files/upload/init", {
        method: "POST",
        body: JSON.stringify({
          originalName: item.file.name,
          size: item.file.size,
          mimeType: item.file.type || undefined,
          category,
          directToStorage: true,
          ...(contentHash ? { contentHash } : {}),
        }),
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;
      patch(item.key, { status: "uploading", progress: 0, duplicateOf: init.duplicateOf, fileId: init.file.id });

      // Direct browser-to-Blob upload, guarded so it can never hang at 0%.
      await uploadPresignedGuarded({
        file: item.file,
        pathname: init.pathname,
        clientPayload: JSON.stringify({ fileId: init.file.id, originalName: item.file.name }),
        controller,
        onProgress: (percentage) => {
          patch(item.key, { progress: percentage });
        },
      });

      if (controller.signal.aborted) return;
      patch(item.key, { status: "finalizing", progress: 100, contentHash });
      let completed;
      try {
        completed = await apiFetch<{ file: SerializedFile; duplicateOf: { id: string; originalName: string } | null }>(
          `/api/files/${init.file.id}/complete`,
          { method: "POST", body: JSON.stringify(contentHash ? { contentHash } : {}), signal: controller.signal },
        );
      } catch (finalizeError) {
        // The bytes are already in private Blob; only the metadata write failed.
        // Mark the row orphaned so retry re-runs finalization instead of
        // uploading a second copy of the same document.
        patch(item.key, { orphaned: true });
        throw finalizeError;
      }
      patch(item.key, { status: "done", progress: 100, orphaned: false, duplicateOf: completed.duplicateOf ?? init.duplicateOf });
      // Requirement: a finished upload appears in the list straight away, not
      // only after the modal is closed. The list refetch is stale-while-
      // revalidate, so the table stays interactive behind the dialog.
      window.dispatchEvent(new Event("nfc:files-changed"));
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        // Aborts come from the user (cancel) or a guard tripping; guards embed
        // their own message in the rejection, so only plain aborts say "cancelled".
        const message = error instanceof Error && !isAbortError(error) ? uploadErrorMessage(error) : "Upload cancelled.";
        patch(item.key, { status: "error", error: message });
        return;
      }
      patch(item.key, { status: "error", error: uploadErrorMessage(error) });
    } finally {
      aborters.current.delete(item.key);
    }
  }, [patch, category, finalizeOrphan]);

  useEffect(() => {
    if (activeKey || activeStartRef.current) return;
    const next = items.find((item) => item.status === "queued");
    if (!next) return;
    activeStartRef.current = next.key;
    const timer = window.setTimeout(() => {
      setActiveKey(next.key);
      void processItem(next)
        .catch(() => undefined)
        .finally(() => {
          activeStartRef.current = null;
          setActiveKey((current) => current === next.key ? null : current);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (activeStartRef.current === next.key && !activeKey) activeStartRef.current = null;
    };
  }, [activeKey, items, processItem]);

  const addFiles = (files: FileList | File[]) => {
    const candidates = [...files];
    const emptyFiles = candidates.filter((file) => file.size === 0);
    const unsupported = candidates.filter((file) => !SUPPORTED_NAME.test(file.name));
    if (emptyFiles.length > 0) toast("Empty files cannot be uploaded.", "warning");
    if (unsupported.length > 0) toast("Only PDF, DOC, DOCX, TXT, PPT, and PPTX files can be uploaded.", "warning");
    const list = candidates.filter((file) => file.size > 0 && SUPPORTED_NAME.test(file.name)).slice(0, 10);
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
        contentHash: null,
        orphaned: false,
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
          <p className="mt-0.5 text-xs text-ink-muted">Up to 10 files at a time · direct-to-storage upload (OIDC)</p>
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
                {item.status === "error" && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm mt-1.5"
                    onClick={() => patch(item.key, { status: "queued", progress: item.orphaned ? 100 : 0, error: null })}
                  >
                    {/* An orphaned row already has its bytes in private storage: retry finishes the metadata only. */}
                    {item.orphaned ? "Finish upload (metadata only)" : "Retry upload"}
                  </button>
                )}
                {item.orphaned && item.status === "error" && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      The document reached private storage, but its details could not be saved. It will appear in the list once
                      finalization succeeds; otherwise scheduled cleanup removes the orphan automatically.
                    </span>
                  </p>
                )}
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

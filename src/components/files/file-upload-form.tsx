"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, FileText, LoaderCircle, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { apiFetch, ClientApiError } from "@/lib/client/api";
import { formatBytes, retentionLabel } from "@/utils/format";
import { DOCUMENT_ACCEPT, getDocumentExtension, inspectDocumentSignature, stripDocumentExtension } from "@/lib/validation/documents";
import type { RetentionType, SerializedFile } from "@/types/file";
import type { SerializedSettings } from "@/types/settings";

interface UploadInitResponse {
  file: SerializedFile;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

function directPut(url: string, file: File, headers: Record<string, string>, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => reject(new Error("The document could not be uploaded to private storage."));
    xhr.onabort = () => reject(new Error("The document upload was cancelled."));
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("The document storage service rejected the upload."));
    xhr.send(file);
  });
}

async function clientDocumentCheck(file: File): Promise<string | null> {
  const extension = getDocumentExtension(file.name);
  if (!extension) return "Only PDF, DOC, DOCX, TXT, PPT, and PPTX files can be selected.";
  if (file.size <= 0) return "The selected document is empty.";
  if (extension === "txt") return null; // Plain text is validated by extension/MIME + server size checks.
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const result = inspectDocumentSignature(extension, bytes);
  if (!result.valid) return result.reason ?? "This file does not appear to have a valid document signature.";
  return null;
}

export function FileUploadForm({ onUploaded }: { onUploaded: () => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<SerializedSettings | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [autoDeleteEnabled, setAutoDeleteEnabled] = useState(false);
  const [retentionType, setRetentionType] = useState<RetentionType>("6_months");
  const [customDeleteAt, setCustomDeleteAt] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "warning"; text: string } | null>(null);

  useEffect(() => {
    apiFetch<{ settings: SerializedSettings }>("/api/settings").then(({ settings: current }) => {
      setSettings(current); setAutoDeleteEnabled(current.defaultAutoDelete); setRetentionType(current.defaultRetentionType);
    }).catch(() => setMessage({ type: "error", text: "Upload settings are unavailable. Refresh the page or contact an administrator." }));
  }, []);

  const chooseFile = useCallback(async (candidate: File | undefined) => {
    if (!candidate) return;
    setMessage(null);
    const issue = await clientDocumentCheck(candidate);
    if (issue) { setFile(null); setMessage({ type: "error", text: issue }); return; }
    if (settings && candidate.size > settings.maxPdfSizeBytes) {
      setFile(null); setMessage({ type: "error", text: `This document is larger than the configured ${formatBytes(settings.maxPdfSizeBytes)} limit.` }); return;
    }
    setFile(candidate);
    if (!title) setTitle(stripDocumentExtension(candidate.name));
  }, [settings, title]);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy || !settings) return;
    setBusy(true); setProgress(0); setMessage(null);
    try {
      const issue = await clientDocumentCheck(file);
      if (issue) throw new ClientApiError("INVALID_DOCUMENT", issue);
      if (file.size > settings.maxPdfSizeBytes) throw new ClientApiError("FILE_TOO_LARGE", `This document is larger than the configured ${formatBytes(settings.maxPdfSizeBytes)} limit.`);
      const retention = { autoDeleteEnabled, retentionType, customDeleteAt: retentionType === "custom_date" ? customDeleteAt || null : null };
      const init = await apiFetch<UploadInitResponse>("/api/files/upload/init", {
        method: "POST",
        body: JSON.stringify({ originalName: file.name, size: file.size, mimeType: file.type, title, description, category, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), retention }),
      });
      await directPut(init.uploadUrl, file, init.uploadHeaders, setProgress);
      await apiFetch<{ file: SerializedFile }>(`/api/files/${init.file.id}/complete`, { method: "POST", body: "{}" });
      setProgress(100);
      setMessage({ type: "success", text: `“${file.name}” was verified and saved to private storage.` });
      setFile(null); setTitle(""); setDescription(""); setCategory(""); setTags("");
      if (inputRef.current) inputRef.current.value = "";
      onUploaded();
    } catch (caught) {
      setProgress(null);
      setMessage({ type: "error", text: caught instanceof ClientApiError ? caught.message : "The upload failed. No active document record was created; please try again." });
    } finally { setBusy(false); }
  }

  return <section className="panel p-5 sm:p-6"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ngo-50 text-ngo-700"><Upload className="h-5 w-5" /></span><div><h2 className="font-bold text-ink-900">Upload a document</h2><p className="mt-1 text-sm leading-5 text-slate-600">Files upload directly to the private R2 bucket through a short-lived, administrator-authorized URL. The gateway verifies the PDF, DOC, DOCX, TXT, PPT, or PPTX before it becomes active.</p></div></div>
    <form className="mt-5 space-y-5" onSubmit={upload}>
      {message && <Notice type={message.type}>{message.text}</Notice>}
      <div onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void chooseFile(event.dataTransfer.files[0]); }} className={`rounded-xl border-2 border-dashed p-5 text-center transition sm:p-7 ${dragging ? "border-ngo-600 bg-ngo-50" : "border-slate-300 bg-slate-50"}`}>
        <input ref={inputRef} id={inputId} type="file" accept={DOCUMENT_ACCEPT} className="sr-only" onChange={(event) => void chooseFile(event.target.files?.[0])} disabled={busy} />
        <FileText className="mx-auto h-8 w-8 text-ngo-600" aria-hidden="true" />
        {file ? <div className="mt-3"><p className="font-semibold text-ink-900">{file.name}</p><p className="mt-1 text-sm text-slate-600">{formatBytes(file.size)} · document signature checked in your browser</p><button type="button" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-red-700 hover:underline" disabled={busy} onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ""; }}><X className="h-4 w-4" />Remove file</button></div> : <div className="mt-3"><p className="font-semibold text-ink-900">Drop a document here, or choose one</p><p className="mt-1 text-sm text-slate-600">PDF, DOC, DOCX, TXT, PPT, PPTX · Up to {settings ? formatBytes(settings.maxPdfSizeBytes) : "the configured limit"}</p><Button className="mt-4" variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>Choose document</Button></div>}
      </div>
      {progress !== null && <div aria-live="polite"><div className="mb-1 flex justify-between text-sm font-semibold text-ink-700"><span>{progress === 100 ? "Finalizing verified document" : "Uploading privately"}</span><span>{progress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div className="h-full rounded-full bg-ngo-600 transition-all" style={{ width: `${progress}%` }} /></div></div>}
      <div className="grid gap-4 sm:grid-cols-2"><div><label className="field-label" htmlFor="upload-title">Title</label><input id="upload-title" className="field-input" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} placeholder="Document title" disabled={busy} /></div><div><label className="field-label" htmlFor="upload-category">Category</label><input id="upload-category" className="field-input" value={category} maxLength={80} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Reports" disabled={busy} /></div></div>
      <div><label className="field-label" htmlFor="upload-description">Description <span className="font-normal text-slate-500">(optional)</span></label><textarea id="upload-description" className="field-input min-h-20 resize-y" value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} placeholder="A short explanation to help staff find this document." disabled={busy} /></div>
      <div><label className="field-label" htmlFor="upload-tags">Tags <span className="font-normal text-slate-500">(comma separated)</span></label><input id="upload-tags" className="field-input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="annual, board, 2025" disabled={busy} /></div>
      <fieldset className="rounded-xl border border-slate-200 p-4"><legend className="px-1 text-sm font-bold text-ink-900">Retention</legend><label className="mt-1 flex items-start gap-3 text-sm text-ink-700"><input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-ngo-600 focus:ring-ngo-600" checked={autoDeleteEnabled} onChange={(event) => setAutoDeleteEnabled(event.target.checked)} disabled={busy} /><span><strong>Enable automatic deletion</strong><span className="mt-0.5 block text-slate-600">When due, this document moves to Trash first and remains recoverable for the configured trash period.</span></span></label>
        {autoDeleteEnabled && <div className="mt-4 grid gap-4 sm:grid-cols-2"><div><label className="field-label" htmlFor="upload-retention">Delete after</label><select id="upload-retention" className="field-input" value={retentionType} onChange={(event) => setRetentionType(event.target.value as RetentionType)} disabled={busy}>{(["never", "30_days", "3_months", "6_months", "1_year", "custom_date"] as RetentionType[]).map((value) => <option key={value} value={value}>{retentionLabel(value)}</option>)}</select></div>{retentionType === "custom_date" && <div><label className="field-label" htmlFor="upload-custom-date">Custom deletion date</label><input id="upload-custom-date" className="field-input" type="date" value={customDeleteAt} onChange={(event) => setCustomDeleteAt(event.target.value)} disabled={busy} /></div>}</div>}
      </fieldset>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs leading-5 text-slate-500">The server verifies filename, size, R2 object metadata, and the document signature for PDF, DOC/DOCX, PPT/PPTX, and TXT uploads. Do not upload confidential material unless your NGO’s policy permits it.</p><Button type="submit" disabled={!file || busy || !settings} className="shrink-0">{busy ? <><LoaderCircle className="h-4 w-4 animate-spin" />Uploading…</> : <><CheckCircle2 className="h-4 w-4" />Upload & verify</>}</Button></div>
    </form>
  </section>;
}

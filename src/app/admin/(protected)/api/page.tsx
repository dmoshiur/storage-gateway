"use client";

import { useState } from "react";
import { Globe, ShieldCheck } from "lucide-react";
import { useSession } from "@/components/providers";
import { useBaseUrl } from "@/hooks/use-base-url";
import { CopyButton } from "@/components/ui/data";
import { EmptyState } from "@/components/ui/feedback";
import { ApiKeysTab } from "@/components/api/api-keys-tab";
import { ApiDocsTab } from "@/components/api/api-docs-tab";
import { ApiPlaygroundTab } from "@/components/api/api-playground-tab";

const TABS = [
  { id: "keys", label: "API keys" },
  { id: "docs", label: "Documentation" },
  { id: "playground", label: "Playground" },
] as const;

export default function ApiPage() {
  const { session } = useSession();
  const baseUrl = useBaseUrl();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("keys");

  if (session && session.role !== "admin") {
    return (
      <div className="tbl-wrap">
        <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="Admins only" description="API key management requires the administrator role." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">API Access</h1>
        <p className="page-sub">Connect your NGO website and other authorized applications.</p>
      </div>

      <div className="card-pad flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-300">
          <Globe className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Base URL</p>
          <p className="mt-0.5 flex items-center gap-2 font-mono text-sm text-ink">
            <span className="truncate">{baseUrl || "Resolving current domain…"}</span>
            <span className="whitespace-nowrap text-ink-muted">/api/v1</span>
          </p>
        </div>
        {baseUrl && <CopyButton value={`${baseUrl}/api/v1`} label="Copy base URL" />}
      </div>

      <div className="tablist" role="tablist" aria-label="API sections">
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={tab === candidate.id}
            className={`tab ${tab === candidate.id ? "tab-active" : ""}`}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      {tab === "keys" && <ApiKeysTab baseUrl={baseUrl} />}
      {tab === "docs" && <ApiDocsTab baseUrl={baseUrl} />}
      {tab === "playground" && <ApiPlaygroundTab baseUrl={baseUrl} />}
    </div>
  );
}

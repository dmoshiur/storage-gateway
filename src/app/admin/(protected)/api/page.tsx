"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useSession } from "@/components/providers";
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
        <h1 className="page-title">API</h1>
        <p className="page-sub">Keys, documentation, and a live playground for integrations.</p>
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
      {tab === "keys" && <ApiKeysTab />}
      {tab === "docs" && <ApiDocsTab />}
      {tab === "playground" && <ApiPlaygroundTab />}
    </div>
  );
}

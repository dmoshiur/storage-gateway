"use client";

import { Suspense } from "react";
import { FilesView } from "@/components/files/files-view";
import { PageSkeleton } from "@/components/ui/feedback";

export default function FilesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <FilesView
        mode="files"
        title="Files"
        description="Browse, preview, and manage every document in the library."
        emptyTitle="No PDF files yet"
        emptyDescription="Upload your organization's first document to get started."
      />
    </Suspense>
  );
}

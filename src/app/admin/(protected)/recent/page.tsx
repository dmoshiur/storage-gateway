"use client";

import { Suspense } from "react";
import { FilesView } from "@/components/files/files-view";
import { PageSkeleton } from "@/components/ui/feedback";

export default function RecentPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <FilesView
        mode="recent"
        title="Recent"
        description="Documents uploaded in the last 30 days."
        emptyTitle="No recent files"
        emptyDescription="Files uploaded in the last 30 days will appear here."
      />
    </Suspense>
  );
}

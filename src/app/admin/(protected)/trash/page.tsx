"use client";

import { Suspense } from "react";
import { FilesView } from "@/components/files/files-view";
import { PageSkeleton } from "@/components/ui/feedback";

export default function TrashPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <FilesView
        mode="trash"
        title="Trash"
        description="Files are permanently deleted after the Trash retention period."
        emptyTitle="Trash is empty"
        emptyDescription="Deleted files will appear here until they expire."
      />
    </Suspense>
  );
}

"use client";

import { Suspense } from "react";
import { FilesView } from "@/components/files/files-view";
import { PageSkeleton } from "@/components/ui/feedback";

export default function FavoritesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <FilesView
        mode="favorites"
        title="Favorites"
        description="Important documents pinned by your team."
        emptyTitle="No favorites yet"
        emptyDescription="Favorite a document from its actions menu to pin it here."
      />
    </Suspense>
  );
}

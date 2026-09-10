export interface SerializedCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export const CATEGORY_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "blue",
  "purple",
  "pink",
] as const;

export type CategoryColor = (typeof CATEGORY_COLORS)[number];

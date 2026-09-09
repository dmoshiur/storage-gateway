import { ApiError } from "@/lib/api/errors";
import type { RetentionType } from "@/types/file";
import { addDays, addMonthsClamped, parseDateOnlyAtEndOfDay } from "@/utils/date";

export interface RetentionInput {
  autoDeleteEnabled: boolean;
  retentionType: RetentionType;
  customDeleteAt?: string | null;
}

export function calculateDeleteAt(input: RetentionInput, now = new Date()): Date | null {
  if (!input.autoDeleteEnabled || input.retentionType === "never") return null;

  switch (input.retentionType) {
    case "30_days":
      return addDays(now, 30);
    case "3_months":
      return addMonthsClamped(now, 3);
    case "6_months":
      return addMonthsClamped(now, 6);
    case "1_year":
      return addMonthsClamped(now, 12);
    case "custom_date": {
      if (!input.customDeleteAt) throw new ApiError(400, "INVALID_RETENTION", "Choose a custom deletion date.");
      const date = parseDateOnlyAtEndOfDay(input.customDeleteAt);
      if (!date || date.getTime() <= now.getTime()) {
        throw new ApiError(400, "INVALID_RETENTION", "The custom deletion date must be in the future.");
      }
      return date;
    }
  }
}

export function defaultRetention(input: { defaultAutoDelete: boolean; defaultRetentionType: Exclude<RetentionType, "custom_date"> }): RetentionInput {
  return {
    autoDeleteEnabled: input.defaultAutoDelete,
    retentionType: input.defaultRetentionType,
    customDeleteAt: null,
  };
}

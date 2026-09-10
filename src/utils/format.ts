export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? Math.round(value) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return "—";
  const seconds = Math.round((date - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return seconds <= 0 ? "just now" : "in a moment";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_557_600],
    ["month", 2_629_800],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const RETENTION_LABELS: Record<string, string> = {
  never: "Never",
  "30_days": "30 days",
  "3_months": "3 months",
  "6_months": "6 months",
  "1_year": "1 year",
  custom_date: "Custom",
};

export function formatRetention(type: string | null | undefined, autoDelete: boolean): string {
  if (!autoDelete) return "Never";
  return RETENTION_LABELS[type ?? ""] ?? type ?? "—";
}

export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value;
  const keep = Math.floor((max - 1) / 2);
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

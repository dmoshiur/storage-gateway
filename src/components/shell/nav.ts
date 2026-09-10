import {
  Activity,
  Bell,
  Blocks,
  Clock3,
  FileText,
  Files,
  Heart,
  KeyRound,
  LayoutDashboard,
  ScrollText,
  Settings,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Users,
  Warehouse,
  Hourglass,
  CircleUserRound,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@/types/auth";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  roles?: Role[];
  shortcut?: string;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    title: null,
    items: [{ href: "/admin/overview", label: "Overview", icon: LayoutDashboard, shortcut: "G O" }],
  },
  {
    title: "Files",
    items: [
      { href: "/admin/files", label: "All Files", icon: Files, shortcut: "G F" },
      { href: "/admin/recent", label: "Recent", icon: Clock3, shortcut: "G R" },
      { href: "/admin/favorites", label: "Favorites", icon: Heart },
      { href: "/admin/trash", label: "Trash", icon: Trash2, shortcut: "G T" },
    ],
  },
  {
    title: "Management",
    items: [
      { href: "/admin/users", label: "Users", icon: Users, roles: ["admin"] },
      { href: "/admin/api", label: "API", icon: KeyRound, roles: ["admin"] },
      { href: "/admin/webhooks", label: "Webhooks", icon: Blocks, roles: ["admin"] },
      { href: "/admin/activity", label: "Activity", icon: Activity },
      { href: "/admin/audit", label: "Audit Logs", icon: ScrollText, roles: ["admin"] },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/admin/storage", label: "Storage", icon: Warehouse, shortcut: "G S" },
      { href: "/admin/retention", label: "Retention", icon: Hourglass },
      { href: "/admin/notifications", label: "Notifications", icon: Bell },
      { href: "/admin/security", label: "Security", icon: ShieldCheck, roles: ["admin"] },
      { href: "/admin/system", label: "System Health", icon: Stethoscope, roles: ["admin"] },
      { href: "/admin/settings", label: "Settings", icon: Settings, roles: ["admin"] },
    ],
  },
];

export const ACCOUNT_NAV: NavItem = { href: "/admin/account", label: "Account", icon: CircleUserRound };

const LABELS: Record<string, string> = {
  overview: "Overview",
  files: "All Files",
  recent: "Recent",
  favorites: "Favorites",
  trash: "Trash",
  users: "Users",
  api: "API",
  webhooks: "Webhooks",
  activity: "Activity",
  audit: "Audit Logs",
  storage: "Storage",
  retention: "Retention",
  notifications: "Notifications",
  security: "Security",
  system: "System Health",
  settings: "Settings",
  account: "Account",
};

export function breadcrumbFor(pathname: string): { href: string; label: string }[] {
  const crumbs = [{ href: "/admin/overview", label: "Home" }];
  const segment = pathname.replace(/^\/admin\/?/, "").split("/")[0] ?? "";
  if (segment && segment !== "overview" && LABELS[segment]) {
    crumbs.push({ href: `/admin/${segment}`, label: LABELS[segment]! });
  } else if (segment === "overview" || segment === "") {
    crumbs.push({ href: "/admin/overview", label: "Overview" });
  }
  return crumbs;
}

export { FileText };

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, Database } from "lucide-react";
import { NAV, type NavItem } from "@/components/shell/nav";
import type { Role } from "@/types/auth";

function Item({ item, collapsed, active }: { item: NavItem; collapsed: boolean; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      data-active={active}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`nav-item ${collapsed ? "justify-center px-0" : ""}`}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

export function Sidebar({
  role,
  collapsed,
  onToggle,
}: {
  role: Role;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  return (
    <div className={`flex h-full flex-col ${collapsed ? "items-center" : ""}`}>
      <div className={`flex h-14 w-full items-center gap-2.5 border-b border-line px-3 ${collapsed ? "justify-center px-0" : ""}`}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
          <Database className="h-4 w-4" />
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-5 text-ink">NGO File Cloud</span>
            <span className="block text-[11px] leading-4 text-ink-faint">Private Documents</span>
          </span>
        )}
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-2">
        {NAV.map((section) => {
          const items = section.items.filter((item) => !item.roles || item.roles.includes(role));
          if (items.length === 0) return null;
          return (
            <div key={section.title ?? "top"}>
              {section.title && !collapsed && <p className="nav-section">{section.title}</p>}
              {section.title && collapsed && <div className="mx-2 my-2 border-t border-line" aria-hidden="true" />}
              <div className="space-y-0.5">
                {items.map((item) => (
                  <Item key={item.href} item={item} collapsed={collapsed} active={pathname === item.href || pathname.startsWith(`${item.href}/`)} />
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`nav-item ${collapsed ? "justify-center px-0" : ""}`}
        >
          {collapsed ? <ChevronsRight className="h-[18px] w-[18px]" /> : (
            <>
              <ChevronsLeft className="h-[18px] w-[18px]" />
              <span>Collapse</span>
            </>
          )}
        </button>
        {!collapsed && <p className="px-2.5 pb-1 pt-2 font-mono text-[11px] text-ink-faint">NGO File Cloud v1.0.0</p>}
      </div>
    </div>
  );
}

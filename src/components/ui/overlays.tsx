"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Shared overlay behavior: refcounted body scroll lock, Escape handling,
   focus trapping, and focus restoration. Every modal/drawer/overlay in
   the app uses these primitives so opening or closing one overlay can
   never leave the body scrolled-locked or the page frozen.             */
/* ------------------------------------------------------------------ */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

/** Module-level registry, kept simple: one overlay stack + one scroll lock count. */
let scrollLockCount = 0;
let scrollLockPrevious = "";
const overlayStack: string[] = [];

function acquireScrollLock() {
  if (typeof document === "undefined") return;
  if (scrollLockCount === 0) {
    scrollLockPrevious = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function releaseScrollLock() {
  if (typeof document === "undefined") return;
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.style.overflow = scrollLockPrevious;
}

interface OverlayBehaviorOptions {
  onClose: () => void;
  /** When false, Escape and backdrop clicks are ignored (used for critical, in-flight operations). */
  dismissable?: boolean;
  /** When false (e.g. a conditionally-rendered overlay that is currently closed), behavior is inert. */
  active?: boolean;
}

/**
 * Hook shared by Dialog, Drawer, the confirm dialog, the command palette and
 * the PDF viewer. Returns a ref to attach to the panel/focus container.
 */
export function useOverlayBehavior({ onClose, dismissable = true, active = true }: OverlayBehaviorOptions) {
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayId = useId();
  const onCloseRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);

  // Keep the latest close handler/dismissability available to the key listener
  // without re-subscribing the whole effect on every render.
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissableRef.current = dismissable;
  }, [onClose, dismissable]);

  useEffect(() => {
    if (typeof document === "undefined" || !active) return;
    const id = overlayId;
    overlayStack.push(id);
    acquireScrollLock();

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus the first interactive element (or the panel itself) after paint.
    const focusTimer = window.setTimeout(() => {
      const node = panelRef.current;
      if (!node || node.contains(document.activeElement)) return;
      const focusables = getFocusableElements(node);
      (focusables[0] ?? node).focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      // Only the topmost overlay reacts, so stacked dialogs close one at a time.
      if (overlayStack[overlayStack.length - 1] !== id) return;

      if (event.key === "Escape") {
        if (!dismissableRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key === "Tab") {
        const node = panelRef.current;
        if (!node) return;
        const focusables = getFocusableElements(node);
        if (focusables.length === 0) {
          event.preventDefault();
          node.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (!node.contains(active)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      // Only the topmost overlay restores focus on close; when a newer overlay
      // is still open above us, it owns focus and its cleanup handles restore.
      const wasTop = overlayStack[overlayStack.length - 1] === id;
      const index = overlayStack.lastIndexOf(id);
      if (index !== -1) overlayStack.splice(index, 1);
      releaseScrollLock();
      if (wasTop && previouslyFocused && previouslyFocused.isConnected) {
        (previouslyFocused as HTMLElement).focus();
      }
    };
  }, [overlayId, active]);

  return panelRef;
}

interface DialogProps {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Pass false to keep the dialog open while a critical operation finishes. */
  dismissable?: boolean;
}

export function Dialog({ title, description, onClose, children, wide, dismissable = true }: DialogProps) {
  const panelRef = useOverlayBehavior({ onClose, dismissable });
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center overflow-y-auto p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}>
      <div className="overlay" onClick={dismissable ? onClose : undefined} aria-hidden="true" />
      <div ref={panelRef} className={`dialog-panel relative ${wide ? "max-w-3xl" : ""}`} tabIndex={-1}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-semibold text-ink">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            disabled={!dismissable}
            className="btn-icon -mr-2 -mt-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface DrawerProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  dismissable?: boolean;
}

export function Drawer({ title, onClose, children, wide, dismissable = true }: DrawerProps) {
  const panelRef = useOverlayBehavior({ onClose, dismissable });
  const titleId = useId();

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="overlay" onClick={dismissable ? onClose : undefined} aria-hidden="true" />
      <aside ref={panelRef} className={`drawer-panel ${wide ? "max-w-2xl" : ""}`} tabIndex={-1}>
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <h2 id={titleId} className="truncate text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" aria-label="Close panel" onClick={onClose} disabled={!dismissable} className="btn-icon -mr-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Viewport-aware menu placement                                       */
/*                                                                     */
/* Pure geometry shared by Dropdown: given the trigger rect, the       */
/* rendered menu size and the viewport, compute where the menu goes so */
/* it always fits inside the viewport (opening upward / flipping       */
/* sides / capping its height instead of ever leaving the screen).     */
/* ------------------------------------------------------------------ */

/** Safe distance the menu keeps from every viewport edge. */
const MENU_EDGE_MARGIN = 8;
/** Gap between trigger and menu. */
const MENU_TRIGGER_GAP = 6;
/** The menu never shrinks below this height (a couple of visible items). */
const MENU_MIN_HEIGHT = 56;
/** The menu never shrinks below this width. */
const MENU_MIN_WIDTH = 160;

export interface MenuPlacementInput {
  /** Trigger bounding rect in viewport coordinates. */
  trigger: { top: number; left: number; right: number; bottom: number };
  /** Rendered menu size: width already capped to the viewport, height the full content height at that width. */
  menu: { width: number; height: number };
  /** Visible viewport size. */
  viewport: { width: number; height: number };
  align?: "left" | "right";
}

export interface MenuPlacement {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
  /** "below" when the menu opens under the trigger, "above" when it flips upward. */
  placement: "below" | "above";
}

export function computeMenuPlacement({ trigger, menu, viewport, align = "right" }: MenuPlacementInput): MenuPlacement {
  const width = Math.min(menu.width, Math.max(MENU_MIN_WIDTH, viewport.width - MENU_EDGE_MARGIN * 2));

  // Vertical: prefer opening below; flip above when it does not fit below;
  // cap the height (the menu scrolls internally) when it fits neither way.
  const spaceBelow = viewport.height - MENU_EDGE_MARGIN - (trigger.bottom + MENU_TRIGGER_GAP);
  const spaceAbove = trigger.top - MENU_TRIGGER_GAP - MENU_EDGE_MARGIN;
  let placement: "below" | "above";
  let top: number;
  let maxHeight: number;
  if (menu.height <= spaceBelow) {
    placement = "below";
    top = trigger.bottom + MENU_TRIGGER_GAP;
    maxHeight = menu.height;
  } else if (menu.height <= spaceAbove) {
    placement = "above";
    top = trigger.top - MENU_TRIGGER_GAP - menu.height;
    maxHeight = menu.height;
  } else if (spaceBelow >= spaceAbove) {
    placement = "below";
    top = trigger.bottom + MENU_TRIGGER_GAP;
    maxHeight = Math.max(MENU_MIN_HEIGHT, spaceBelow);
  } else {
    placement = "above";
    maxHeight = Math.max(MENU_MIN_HEIGHT, spaceAbove);
    top = trigger.top - MENU_TRIGGER_GAP - maxHeight;
  }

  // Safety clamp so the menu stays inside the viewport on pathological viewports.
  top = Math.min(Math.max(top, MENU_EDGE_MARGIN), Math.max(MENU_EDGE_MARGIN, viewport.height - MENU_EDGE_MARGIN - Math.min(maxHeight, menu.height)));
  maxHeight = Math.max(MENU_MIN_HEIGHT, Math.min(maxHeight, viewport.height - MENU_EDGE_MARGIN - top));

  // Horizontal: honor the requested anchor side, flip toward the other side
  // when there is not enough space there, then clamp to the safe margin.
  let left: number;
  if (align === "left") {
    left = trigger.left;
    if (left + width > viewport.width - MENU_EDGE_MARGIN) left = trigger.right - width;
  } else {
    left = trigger.right - width;
    if (left < MENU_EDGE_MARGIN) left = trigger.left;
  }
  left = Math.min(Math.max(left, MENU_EDGE_MARGIN), Math.max(MENU_EDGE_MARGIN, viewport.width - MENU_EDGE_MARGIN - width));

  return { top, left, maxWidth: width, maxHeight, placement };
}

interface DropdownProps {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  align?: "left" | "right";
}

/**
 * Viewport-aware action menu (the 3-dot / "manage" / filter dropdown).
 *
 * The menu renders into a portal on `document.body` with `position: fixed`,
 * so it can never be clipped by an ancestor's overflow (table wrappers,
 * cards) and it is placed from a measurement of the actual viewport:
 * it opens below by default, flips upward near the bottom edge, flips /
 * clamps horizontally near the left/right edges, and caps its height so
 * long menus scroll internally instead of pushing content off-screen.
 */
export function Dropdown({ trigger, label, children, align = "right" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const layoutMenu = useCallback(() => {
    const triggerEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!triggerEl || !menuEl) return;

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const anchor = triggerEl.getBoundingClientRect();

    // Width: measure the natural fit-content width (with the cap removed so
    // resizes can grow the menu back) and cap it to the viewport.
    const previousMaxWidth = menuEl.style.maxWidth;
    menuEl.style.maxWidth = "none";
    const naturalWidth = menuEl.scrollWidth;
    menuEl.style.maxWidth = previousMaxWidth;
    const width = Math.min(naturalWidth, Math.max(MENU_MIN_WIDTH, viewport.width - MENU_EDGE_MARGIN * 2));
    menuEl.style.maxWidth = `${width}px`;

    // Placement from the rendered size: scrollHeight is the full content
    // height regardless of any max-height, so the fit checks are exact.
    const placement = computeMenuPlacement({
      trigger: anchor,
      menu: { width: menuEl.offsetWidth, height: menuEl.scrollHeight },
      viewport,
      align,
    });

    menuEl.style.top = `${placement.top}px`;
    menuEl.style.left = `${placement.left}px`;
    menuEl.style.maxHeight = `${placement.maxHeight}px`;
    menuEl.style.visibility = "visible";
  }, [align]);

  // Runs before paint on the client (no flash outside the viewport); a no-op
  // on the server pass where the menu is never open yet.
  useLayoutEffect(() => {
    if (open) layoutMenu();
  }, [open, layoutMenu]);

  // Re-settle after any render that moves the trigger while the menu is open
  // (list refreshes, theme toggle, column changes, …).
  useEffect(() => {
    if (open) layoutMenu();
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // Follow the trigger on any scroll (page or inner containers, via
    // capture) and on resize. Scrolling the menu itself must not reposition.
    const onReposition = (event: Event) => {
      if (event.type === "scroll" && event.target === menuRef.current) return;
      layoutMenu();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    document.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      document.removeEventListener("scroll", onReposition, true);
    };
  }, [open, layoutMenu]);

  const menuStyle: CSSProperties = {
    position: "fixed",
    top: 0,
    left: 0,
    visibility: "hidden",
    // Long menus scroll inside the menu; `contain` stops that scrolling from
    // chaining to the page, so the main view stays fixed while using it.
    overflowY: "auto",
    overscrollBehavior: "contain",
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <div
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
      >
        {trigger}
      </div>
      {open && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (!target.closest("[data-keep-menu]")) setOpen(false);
            }}
            className="menu z-[60]"
            style={menuStyle}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

export function Dropdown({
  trigger,
  label,
  children,
  align = "right",
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <div aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((value) => !value)}>
        {trigger}
      </div>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onClick={() => setOpen(false)}
          className={`menu absolute top-[calc(100%+6px)] z-[60] ${align === "right" ? "right-0" : "left-0"}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

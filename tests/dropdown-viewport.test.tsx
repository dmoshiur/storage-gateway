// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dropdown } from "@/components/ui/overlays";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MARGIN = 8; // must match MENU_EDGE_MARGIN in overlays.tsx
const GAP = 6; // must match MENU_TRIGGER_GAP in overlays.tsx
const EPS = 0.001;

interface Viewport {
  width: number;
  height: number;
}
interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

function rect(top: number, left: number, width: number, height: number): Rect {
  return { top, left, right: left + width, bottom: top + height };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
}

interface Mounted {
  container: HTMLElement;
  root: Root;
  menu: () => HTMLElement | null;
  /** Stub the menu's measured size (jsdom cannot lay out) and re-run placement. */
  measure: (naturalWidth: number, height: number) => Promise<void>;
}

function requireMenu(mounted: Mounted): HTMLElement {
  const el = mounted.menu();
  if (!el) throw new Error("expected the menu to be open");
  return el;
}

async function renderDropdown(vw: number, vh: number, triggerRect: Rect, align: "left" | "right" = "right"): Promise<Mounted> {
  setViewport(vw, vh);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <Dropdown label="Actions" align={align} trigger={<button type="button" aria-label="open">⋮</button>}>
        <div className="menu-sep" />
        <button type="button">Regular action</button>
        <button type="button" data-keep-menu="true">
          Keep action
        </button>
      </Dropdown>,
    );
  });

  // Stub the trigger's viewport rect (jsdom reports all zeros).
  const trigger = container.querySelector<HTMLElement>('[aria-haspopup="menu"]');
  if (!trigger) throw new Error("dropdown trigger not found");
  Object.defineProperty(trigger, "getBoundingClientRect", { value: () => triggerRect, configurable: true });

  const openButton = container.querySelector<HTMLButtonElement>("button[aria-label='open']");
  if (!openButton) throw new Error("open button not found");

  const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');

  await act(async () => {
    openButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  expect(menu(), "menu opens in a portal on document.body").not.toBeNull();

  const measure = async (naturalWidth: number, height: number) => {
    const el = menu();
    if (!el) throw new Error("menu not open");
    const maxWidth = Math.min(naturalWidth, Math.max(160, vw - MARGIN * 2));
    Object.defineProperty(el, "scrollWidth", { value: naturalWidth, configurable: true });
    Object.defineProperty(el, "offsetWidth", { value: Math.min(naturalWidth, maxWidth), configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: height, configurable: true });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
  };

  return { container, root, menu, measure };
}

function parsed(el: HTMLElement) {
  return {
    top: Number.parseFloat(el.style.top),
    left: Number.parseFloat(el.style.left),
    maxWidth: Number.parseFloat(el.style.maxWidth),
    maxHeight: Number.parseFloat(el.style.maxHeight),
  };
}

function expectInside(p: ReturnType<typeof parsed>, menu: { width: number; height: number }, viewport: Viewport) {
  const width = p.maxWidth;
  const height = Math.min(p.maxHeight, menu.height);
  expect(p.left).toBeGreaterThanOrEqual(MARGIN - EPS);
  expect(p.top).toBeGreaterThanOrEqual(MARGIN - EPS);
  expect(p.left + width).toBeLessThanOrEqual(viewport.width - MARGIN + EPS);
  expect(p.top + height).toBeLessThanOrEqual(viewport.height - MARGIN + EPS);
}

describe("Dropdown (3-dot menu) — viewport-aware DOM behavior", () => {
  let mounted: Mounted | null = null;

  afterEach(async () => {
    if (mounted) {
      const current = mounted;
      await act(async () => {
        current.root.unmount();
      });
      current.container.remove();
      mounted = null;
    }
  });

  it("opens below, right-aligned, at natural size on desktop", async () => {
    const viewport = { width: 1440, height: 900 };
    const trigger = rect(300, 900, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 370);

    const el = requireMenu(m);
    expect(el.style.position).toBe("fixed");
    expect(el.style.visibility).toBe("visible");
    expect(el.style.overflowY).toBe("auto");
    expect(el.style.overscrollBehavior).toBe("contain");
    const p = parsed(el);
    expect(p.top).toBe(trigger.bottom + GAP);
    expect(p.left).toBe(trigger.right - 200);
    expect(p.maxHeight).toBe(370);
    expect(p.maxWidth).toBe(200);
    expectInside(p, { width: 200, height: 370 }, viewport);
  });

  it("opens upward when the trigger is near the bottom of the screen", async () => {
    const viewport = { width: 1440, height: 900 };
    const trigger = rect(860, 900, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 370);

    const p = parsed(requireMenu(m));
    expect(p.top + 370).toBe(trigger.top - GAP);
    expectInside(p, { width: 200, height: 370 }, viewport);
  });

  it("stays open downward when the trigger is near the top of the screen", async () => {
    const viewport = { width: 1440, height: 900 };
    const trigger = rect(8, 1050, 28, 40);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 230);

    const p = parsed(requireMenu(m));
    expect(p.top).toBe(trigger.bottom + GAP);
    expectInside(p, { width: 200, height: 230 }, viewport);
  });

  it("fits a right-anchored menu on a 320px phone near the right edge", async () => {
    const viewport = { width: 320, height: 568 };
    const trigger = rect(400, 284, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 200);

    const p = parsed(requireMenu(m));
    expect(p.left).toBe(viewport.width - MARGIN - 200);
    expectInside(p, { width: 200, height: 200 }, viewport);
  });

  it("aligns toward the right when a right-anchored menu overflows the left edge", async () => {
    const viewport = { width: 390, height: 844 };
    const trigger = rect(400, 8, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 200);

    const p = parsed(requireMenu(m));
    expect(p.left).toBe(trigger.left);
    expectInside(p, { width: 200, height: 200 }, viewport);
  });

  it("aligns toward the left when a left-anchored menu overflows the right edge", async () => {
    const viewport = { width: 320, height: 568 };
    const trigger = rect(120, 260, 40, 30);
    const m = await renderDropdown(viewport.width, viewport.height, trigger, "left");
    mounted = m;
    await m.measure(200, 150);

    const p = parsed(requireMenu(m));
    expect(p.left).toBe(trigger.right - 200);
    expectInside(p, { width: 200, height: 150 }, viewport);
  });

  it("caps the height of a long menu on a short screen (menu scrolls internally)", async () => {
    const viewport = { width: 1024, height: 500 };
    const trigger = rect(230, 700, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 430);

    const p = parsed(requireMenu(m));
    expect(p.maxHeight).toBeLessThan(430);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(viewport.height - MARGIN + EPS);
    expectInside(p, { width: 200, height: 430 }, viewport);
  });

  it("caps the width of a wide menu on a 320px viewport", async () => {
    const viewport = { width: 320, height: 600 };
    const trigger = rect(100, 40, 40, 30);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(400, 120);

    const p = parsed(requireMenu(m));
    expect(p.maxWidth).toBe(viewport.width - MARGIN * 2);
    expectInside(p, { width: 400, height: 120 }, viewport);
  });

  it("repositions when the viewport resizes", async () => {
    const trigger = rect(300, 900, 28, 28);
    const m = await renderDropdown(1440, 900, trigger);
    mounted = m;
    await m.measure(200, 370);
    expect(parsed(requireMenu(m)).left).toBe(900 + 28 - 200);

    setViewport(375, 667);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    const p = parsed(requireMenu(m));
    // Trigger rect is unchanged (stubbed); the menu must be clamped to the narrow viewport.
    expect(p.left + p.maxWidth).toBeLessThanOrEqual(375 - MARGIN + EPS);
    expect(p.left).toBeGreaterThanOrEqual(MARGIN - EPS);
    expect(p.top + Math.min(p.maxHeight, 370)).toBeLessThanOrEqual(667 - MARGIN + EPS);
  });

  it("closes on outside pointer-down but not on menu interaction", async () => {
    const viewport = { width: 1024, height: 768 };
    const trigger = rect(200, 500, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 150);
    expect(m.menu()).not.toBeNull();

    // Interaction inside the menu keeps it open.
    const el = requireMenu(m);
    await act(async () => {
      el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(m.menu()).not.toBeNull();

    // Pointer-down outside closes it.
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(m.menu()).toBeNull();
  });

  it("closes on Escape", async () => {
    const viewport = { width: 1024, height: 768 };
    const trigger = rect(200, 500, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 150);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(m.menu()).toBeNull();
  });

  it("clicking a regular item closes the menu; data-keep-menu keeps it open", async () => {
    const viewport = { width: 1024, height: 768 };
    const trigger = rect(200, 500, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 150);

    const keep = requireMenu(m).querySelector<HTMLButtonElement>("[data-keep-menu]");
    if (!keep) throw new Error("keep-menu button not found");
    await act(async () => {
      keep.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(m.menu(), "keep-menu action leaves the menu open").not.toBeNull();

    const regular = requireMenu(m).querySelector<HTMLButtonElement>("button:not([data-keep-menu])");
    if (!regular) throw new Error("regular button not found");
    await act(async () => {
      regular.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(m.menu(), "regular item closes the menu").toBeNull();
  });

  it("renders the menu in a portal on document.body (never clipped by table/card overflow)", async () => {
    const viewport = { width: 1024, height: 768 };
    const trigger = rect(200, 500, 28, 28);
    const m = await renderDropdown(viewport.width, viewport.height, trigger);
    mounted = m;
    await m.measure(200, 150);

    const el = requireMenu(m);
    expect(el.parentElement).toBe(document.body);
    expect(m.container.contains(el)).toBe(false);
  });
});

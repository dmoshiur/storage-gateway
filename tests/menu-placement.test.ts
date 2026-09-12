import { describe, expect, it } from "vitest";
import { computeMenuPlacement } from "@/components/ui/overlays";

/**
 * Geometry tests for the shared Dropdown placement (the 3-dot menu).
 *
 * The menu must stay fully inside the viewport at every supported screen
 * size: it opens below by default, flips upward near the bottom edge,
 * flips/clamps horizontally near the side edges, and caps its height so
 * long menus scroll internally instead of leaving the screen.
 */

const MARGIN = 8; // must match MENU_EDGE_MARGIN in overlays.tsx
const GAP = 6; // must match MENU_TRIGGER_GAP in overlays.tsx
const EPS = 0.001;

type Rect = { top: number; left: number; right: number; bottom: number };

function rect(top: number, left: number, width: number, height: number): Rect {
  return { top, left, right: left + width, bottom: top + height };
}

function place(
  trigger: Rect,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "left" | "right" = "right",
) {
  return computeMenuPlacement({ trigger, menu, viewport, align });
}

/** Asserts the rendered menu box stays inside the viewport safe area. */
function expectInside(
  placement: ReturnType<typeof place>,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const menuWidth = placement.maxWidth;
  const menuHeight = Math.min(placement.maxHeight, menu.height);
  expect(placement.left, "left").toBeGreaterThanOrEqual(MARGIN - EPS);
  expect(placement.top, "top").toBeGreaterThanOrEqual(MARGIN - EPS);
  expect(placement.left + menuWidth, "right").toBeLessThanOrEqual(viewport.width - MARGIN + EPS);
  expect(placement.top + menuHeight, "bottom").toBeLessThanOrEqual(viewport.height - MARGIN + EPS);
}

describe("computeMenuPlacement — default desktop behavior", () => {
  const viewport = { width: 1440, height: 900 };
  const trigger = rect(300, 900, 28, 28);
  const menu = { width: 200, height: 370 };

  it("opens below the trigger, right-aligned, with its natural size", () => {
    const p = place(trigger, menu, viewport);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(trigger.bottom + GAP);
    expect(p.left).toBe(trigger.right - menu.width);
    expect(p.maxHeight).toBe(menu.height);
    expect(p.maxWidth).toBe(menu.width);
  });

  it("keeps a 6px gap below the trigger", () => {
    const p = place(trigger, menu, viewport);
    expect(p.top - trigger.bottom).toBe(GAP);
  });

  it("supports left alignment on wide viewports", () => {
    const p = place(trigger, menu, viewport, "left");
    expect(p.left).toBe(trigger.left);
    expect(p.top).toBe(trigger.bottom + GAP);
  });
});

describe("computeMenuPlacement — vertical behavior", () => {
  const viewport = { width: 1440, height: 900 };

  it("opens upward when there is not enough space below", () => {
    const trigger = rect(860, 900, 28, 28); // 12px above the bottom edge area
    const menu = { width: 200, height: 370 };
    const p = place(trigger, menu, viewport);
    expect(p.placement).toBe("above");
    expect(p.top + menu.height).toBe(trigger.top - GAP);
    expectInside(p, menu, viewport);
  });

  it("stays open downward near the top edge", () => {
    const trigger = rect(8, 1050, 28, 40); // topbar trigger
    const menu = { width: 200, height: 230 };
    const p = place(trigger, menu, viewport);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(trigger.bottom + GAP);
    expectInside(p, menu, viewport);
  });

  it("caps the height and scrolls internally when it fits neither side", () => {
    // Short laptop screen; tall menu in the middle of the page.
    const short = { width: 1024, height: 500 };
    const trigger = rect(250, 700, 28, 45);
    const menu = { width: 200, height: 430 };
    const p = place(trigger, menu, short);
    expect(p.placement).toBe("above"); // more space above than below
    expect(p.maxHeight).toBeLessThan(menu.height);
    expect(p.maxHeight).toBeLessThanOrEqual(trigger.top - GAP - MARGIN + EPS);
    expect(p.top + p.maxHeight).toBe(trigger.top - GAP);
    expectInside(p, menu, short);
  });

  it("caps downward when there is more space below", () => {
    const short = { width: 1024, height: 500 };
    const trigger = rect(100, 700, 28, 45);
    const menu = { width: 200, height: 430 };
    const p = place(trigger, menu, short);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(trigger.bottom + GAP);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(short.height - MARGIN + EPS);
    expectInside(p, menu, short);
  });

  it("never places a very long menu outside the viewport", () => {
    const phone = { width: 320, height: 568 };
    const trigger = rect(270, 146, 28, 28);
    const menu = { width: 200, height: 800 };
    const p = place(trigger, menu, phone);
    expect(p.maxHeight).toBeLessThan(menu.height);
    expectInside(p, menu, phone);
  });
});

describe("computeMenuPlacement — horizontal behavior", () => {
  const phone = { width: 390, height: 844 };

  it("right-aligns to the trigger when there is room on the left", () => {
    const trigger = rect(400, 320, 28, 28); // near the right edge
    const p = place(trigger, { width: 200, height: 200 }, phone);
    expect(p.left).toBe(trigger.right - 200);
    expectInside(p, { width: 200, height: 200 }, phone);
  });

  it("aligns toward the right when a right-anchored menu would overflow the left edge", () => {
    const trigger = rect(400, 12, 28, 28); // near the left edge
    const menu = { width: 200, height: 200 };
    const p = place(trigger, menu, phone);
    expect(p.left).toBe(trigger.left); // flipped to the right of the trigger
    expectInside(p, menu, phone);
  });

  it("aligns toward the left when a left-anchored menu would overflow the right edge", () => {
    const trigger = rect(100, 1400, 28, 28); // near the right edge, left-aligned menu
    const menu = { width: 200, height: 100 };
    const p = place(trigger, menu, { width: 1440, height: 900 }, "left");
    expect(p.left).toBe(trigger.right - menu.width); // flipped left-aligned
    expectInside(p, menu, { width: 1440, height: 900 });
  });

  it("keeps a safe margin from the left and right viewport edges", () => {
    const small = { width: 320, height: 568 };
    for (const [left, width] of [
      [320 - 36, 200],
      [8, 200],
      [146, 320 - 16], // menu as wide as the available viewport
    ] as const) {
      const trigger = rect(200, left, 36, 36);
      const menu = { width, height: 160 };
      const p = place(trigger, menu, small);
      expect(p.left).toBeGreaterThanOrEqual(MARGIN - EPS);
      expect(p.left + p.maxWidth).toBeLessThanOrEqual(small.width - MARGIN + EPS);
      expectInside(p, menu, small);
    }
  });

  it("caps the menu width to the viewport on narrow screens", () => {
    const tiny = { width: 320, height: 600 };
    const trigger = rect(100, 40, 40, 30);
    const p = place(trigger, { width: 400, height: 120 }, tiny);
    expect(p.maxWidth).toBe(tiny.width - MARGIN * 2);
    expectInside(p, { width: 400, height: 120 }, tiny);
  });
});

describe("computeMenuPlacement — sweep across required screen sizes", () => {
  const widths = [320, 375, 390, 430, 768, 1024, 1440];
  const heights = [480, 568, 667, 740, 800, 900, 1080];
  const menus = [
    { width: 200, height: 120 }, // small
    { width: 200, height: 200 }, // typical 3-dot menu
    { width: 200, height: 430 }, // long (user "manage" menu)
    { width: 268, height: 240 }, // filter panel
    { width: 320, height: 600 }, // very long
  ];

  it("keeps the menu inside the viewport for every size, position and alignment", () => {
    for (const vw of widths) {
      for (const vh of heights) {
        const viewport = { width: vw, height: vh };
        const positions: Record<string, Rect> = {
          center: rect(Math.round(vh / 2 - 14), Math.round(vw / 2 - 14), 28, 28),
          "near-top": rect(8, Math.round(vw / 2 - 14), 28, 28),
          "near-bottom": rect(vh - 36, Math.round(vw / 2 - 14), 28, 28),
          "near-left": rect(Math.round(vh / 2 - 14), 8, 28, 28),
          "near-right": rect(Math.round(vh / 2 - 14), vw - 36, 28, 28),
          "top-left-corner": rect(8, 8, 28, 28),
          "bottom-right-corner": rect(vh - 36, vw - 36, 28, 28),
          "top-right-corner": rect(8, vw - 36, 28, 28),
          "bottom-left-corner": rect(vh - 36, 8, 28, 28),
        };
        for (const menu of menus) {
          for (const align of ["left", "right"] as const) {
            for (const [name, trigger] of Object.entries(positions)) {
              const p = place(trigger, menu, viewport, align);
              expectInside(p, menu, viewport);
              // The menu must attach to the trigger on the open side.
              if (p.placement === "below") {
                expect(p.top, `${name}/${vw}x${vh}/${align}`).toBeGreaterThanOrEqual(trigger.bottom + GAP - EPS);
              } else {
                expect(p.top + p.maxHeight, `${name}/${vw}x${vh}/${align}`).toBeLessThanOrEqual(trigger.top - GAP + EPS);
              }
              expect(p.left + p.maxWidth).toBeGreaterThanOrEqual(trigger.left - menu.width - EPS);
              expect(p.left).toBeLessThanOrEqual(trigger.right + menu.width + EPS);
            }
          }
        }
      }
    }
  });
});

/**
 * Smoke test: each view module imports without throwing.
 *
 * This catches "the bundle won't even load" regressions (broken imports,
 * top-level syntax errors, missing exports referenced elsewhere) without
 * having to render the DOM.
 */

import { describe, expect, it } from "vitest";

describe("view modules import cleanly", () => {
  it("auth", async () => {
    const mod = await import("./auth");
    expect(typeof mod.showAuthScreen).toBe("function");
  });

  it("notes", async () => {
    const mod = await import("./notes");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
  });

  it("reading insight", async () => {
    const mod = await import("./reading-insight");
    expect(typeof mod.initReadingInsightPrompts).toBe("function");
  });

  it("feynman", async () => {
    const mod = await import("./feynman");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
    expect(typeof mod.renderInitial).toBe("function");
  });

  it("pomodoro", async () => {
    const mod = await import("./pomodoro");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
    expect(typeof mod.setUser).toBe("function");
  });

  it("stats", async () => {
    const mod = await import("./stats");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
  });

  it("stopwatch", async () => {
    const mod = await import("./stopwatch");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
    expect(typeof mod.setCatSkin).toBe("function");
  });

  it("icons", async () => {
    const mod = await import("./icons");
    expect(typeof mod.renderBeerIconSvg).toBe("function");
    expect(typeof mod.renderFlameIconSvg).toBe("function");
    expect(typeof mod.renderFlowerIconSvg).toBe("function");
    expect(typeof mod.renderSunIconSvg).toBe("function");
    expect(typeof mod.renderMoonIconSvg).toBe("function");
    expect(typeof mod.renderSleepingCatSvg).toBe("function");
    expect(typeof mod.renderEmptyStateWithCat).toBe("function");
    expect(mod.renderBeerIconSvg()).toContain("<svg");
    expect(mod.renderFlameIconSvg()).toContain("<svg");
    expect(mod.renderFlowerIconSvg()).toContain("<svg");
    expect(mod.renderSunIconSvg()).toContain("<svg");
    expect(mod.renderMoonIconSvg()).toContain("<svg");
    expect(mod.renderSleepingCatSvg("tabby")).toContain("<svg");
    // Unknown skin should fall back without throwing.
    expect(() => mod.renderSleepingCatSvg("nope")).not.toThrow();
    expect(mod.renderEmptyStateWithCat("Hi")).toContain("Hi");
  });

  it("user-state", async () => {
    const mod = await import("./user-state");
    expect(typeof mod.getCurrentCatSkin).toBe("function");
    expect(typeof mod.setCurrentCatSkin).toBe("function");
    mod.setCurrentCatSkin("black");
    expect(mod.getCurrentCatSkin()).toBe("black");
    mod.setCurrentCatSkin("tabby"); // restore default for other tests
  });

  it("clock", async () => {
    const mod = await import("./clock");
    expect(typeof mod.renderAnalogClockSvg).toBe("function");
    const svg = mod.renderAnalogClockSvg({ seconds: 0, running: false, catSkin: "tabby" });
    expect(svg).toContain("<svg");
    // Unknown skin id should fall back without throwing.
    expect(() => mod.renderAnalogClockSvg({ seconds: 123, running: true, catSkin: "nonexistent" })).not.toThrow();
  });

  it("avatar", async () => {
    const mod = await import("./avatar");
    expect(typeof mod.renderAvatarSvg).toBe("function");
    expect(Array.isArray(mod.CAT_SKINS)).toBe(true);
    expect(mod.CAT_SKINS.length).toBeGreaterThan(0);
    // Unknown skin id should fall back to a valid SVG, not throw.
    expect(mod.renderAvatarSvg("nonexistent", 32)).toContain("<svg");
  });
});

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

  it("feynman", async () => {
    const mod = await import("./feynman");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
    expect(typeof mod.renderInitial).toBe("function");
  });

  it("tracker", async () => {
    const mod = await import("./tracker");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
  });

  it("pomodoro", async () => {
    const mod = await import("./pomodoro");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
    expect(typeof mod.setUser).toBe("function");
  });

  it("mood", async () => {
    const mod = await import("./mood");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
  });

  it("stats", async () => {
    const mod = await import("./stats");
    expect(typeof mod.init).toBe("function");
    expect(typeof mod.refresh).toBe("function");
  });
});

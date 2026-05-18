/**
 * Unit tests for the shared utility helpers.
 */

import { describe, expect, it } from "vitest";
import { escapeHtml, formatTime, makeDateLabel, setMessage } from "./utils";

describe("escapeHtml", () => {
  it("escapes angle brackets and entities", () => {
    expect(escapeHtml("<script>alert('x')</script>")).not.toContain("<script>");
    expect(escapeHtml("<b>&")).toBe("&lt;b&gt;&amp;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("formatTime", () => {
  it("pads minutes and seconds", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(5)).toBe("00:05");
    expect(formatTime(60)).toBe("01:00");
    expect(formatTime(25 * 60)).toBe("25:00");
    expect(formatTime(25 * 60 + 30)).toBe("25:30");
  });
});

describe("setMessage", () => {
  it("writes text and applies kind-specific class", () => {
    const el = document.createElement("p");
    setMessage(el, "Done", "success");
    expect(el.textContent).toBe("Done");
    expect(el.className).toBe("message success");
    setMessage(el, "Oops", "error");
    expect(el.className).toBe("message error");
    setMessage(el, "");
    expect(el.className).toBe("message neutral");
  });
});

describe("makeDateLabel", () => {
  it("returns a non-empty label", () => {
    expect(makeDateLabel("2026-05-18").length).toBeGreaterThan(0);
  });
});

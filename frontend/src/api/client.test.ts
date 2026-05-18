/**
 * Tests for the API client wrapper: success, 401, errors, 204, JSON parsing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, UnauthorizedError } from "./client";

// The whatwg Response constructor rejects null-body statuses like 204, so we
// build a minimal Response-shaped object exposing the properties apiFetch uses.
function mockFetchOnce(init: { status: number; body?: string }): void {
  const body = init.body ?? "";
  const fake = {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    text: async () => body,
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(fake));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("parses JSON body on 200", async () => {
    mockFetchOnce({ status: 200, body: JSON.stringify({ ok: true, n: 42 }) });
    const data = await apiFetch<{ ok: boolean; n: number }>("/x");
    expect(data).toEqual({ ok: true, n: 42 });
  });

  it("returns undefined on 204", async () => {
    mockFetchOnce({ status: 204 });
    const data = await apiFetch<void>("/x", { method: "DELETE" });
    expect(data).toBeUndefined();
  });

  it("throws UnauthorizedError on 401", async () => {
    mockFetchOnce({ status: 401, body: '{"detail":"nope"}' });
    await expect(apiFetch("/x")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws ApiError on non-2xx with status and body", async () => {
    mockFetchOnce({ status: 422, body: '{"detail":"bad"}' });
    try {
      await apiFetch("/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(422);
      expect((err as ApiError).body).toBe('{"detail":"bad"}');
    }
  });

  it("sends credentials: include and JSON content-type", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await apiFetch("/x");
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.credentials).toBe("include");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });
});

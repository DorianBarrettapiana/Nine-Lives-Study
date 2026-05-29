/**
 * API client utilities.
 */

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?? (import.meta.env.PROD ? "/api" : "http://127.0.0.1:8000");

export class UnauthorizedError extends Error {
  constructor(message: string = "Not authenticated") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// Default request timeout. Long enough to tolerate cold-start backend or slow
// Wi-Fi, short enough that a hung connection doesn't leave the user staring at
// a "Pause" button that never responds. Callers can override via options.signal.
const DEFAULT_TIMEOUT_MS = 12_000;

export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Compose the caller's AbortSignal (if any) with our own timeout signal so
  // either can cancel. AbortSignal.any is widely supported now (Safari 17+).
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(new Error("timeout")), timeoutMs);
  const signals: AbortSignal[] = [timeoutCtrl.signal];
  if (options?.signal) signals.push(options.signal);
  const composedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      // Send and accept the session cookie even when API runs on a different origin in dev.
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      ...options,
      signal: composedSignal,
    });
  } catch (e) {
    // Distinguish "we timed out" from "caller cancelled" from "network died".
    // Surface as ApiError(0, ...) so existing parseDetail() paths handle it.
    if (timeoutCtrl.signal.aborted) {
      throw new ApiError(0, `Request timed out after ${timeoutMs}ms`);
    }
    throw new ApiError(0, e instanceof Error ? e.message : "Network error");
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

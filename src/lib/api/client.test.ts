import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../test/mocks/server";
import { API_UNAUTHORIZED_EVENT, API_USAGE_CHANGED_EVENT, ApiError, apiJson, apiRequest } from "./client";

describe("API client", () => {
  it("uses the page origin, session cookie mode, and JSON content type", async () => {
    server.use(
      http.post(`${window.location.origin}/v1/example`, async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(new URL(request.url).origin).toBe(window.location.origin);
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({ ok: true });
        return HttpResponse.json({ value: 1 });
      }),
    );
    await expect(apiJson<{ value: number }>("/v1/example", "POST", { ok: true })).resolves.toEqual({ value: 1 });
  });

  it("honors an explicit API origin for local development", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8787/");
    vi.resetModules();
    try {
      server.use(http.get("http://localhost:8787/health", () => HttpResponse.json({ ok: true })));
      const client = await import("./client");
      await expect(client.apiRequest("/health")).resolves.toEqual({ ok: true });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("normalizes JSON errors and emits an unauthorized event", async () => {
    const listener = vi.fn();
    window.addEventListener(API_UNAUTHORIZED_EVENT, listener);
    server.use(
      http.get(`${window.location.origin}/v1/private`, () => HttpResponse.json({ error: "Unauthorized" }, { status: 401 })),
    );
    await expect(apiRequest("/v1/private")).rejects.toMatchObject({ status: 401, message: "Unauthorized" } satisfies Partial<ApiError>);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(API_UNAUTHORIZED_EVENT, listener);
  });

  it("does not infer byte usage from credential or SFU control-plane calls", async () => {
    const listener = vi.fn();
    window.addEventListener(API_USAGE_CHANGED_EVENT, listener);
    server.use(
      http.post(`${window.location.origin}/v1/r2/credentials`, () => HttpResponse.json({ objectKey: "test" })),
      http.post(`${window.location.origin}/v1/sfu/sessions/new`, () => HttpResponse.json({ sessionId: "test" })),
    );
    await apiJson("/v1/r2/credentials", "POST", { ttlSeconds: 3600 });
    await apiJson("/v1/sfu/sessions/new", "POST", {});
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(API_USAGE_CHANGED_EVENT, listener);
  });
});

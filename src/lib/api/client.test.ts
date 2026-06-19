import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../test/mocks/server";
import { API_UNAUTHORIZED_EVENT, ApiError, apiJson, apiRequest } from "./client";

describe("API client", () => {
  it("adds the API base URL, session cookie mode, and JSON content type", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/example", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({ ok: true });
        return HttpResponse.json({ value: 1 });
      }),
    );
    await expect(apiJson<{ value: number }>("/v1/example", "POST", { ok: true })).resolves.toEqual({ value: 1 });
  });

  it("normalizes JSON errors and emits an unauthorized event", async () => {
    const listener = vi.fn();
    window.addEventListener(API_UNAUTHORIZED_EVENT, listener);
    server.use(
      http.get("https://api.file.thanejoss.com/v1/private", () => HttpResponse.json({ error: "Unauthorized" }, { status: 401 })),
    );
    await expect(apiRequest("/v1/private")).rejects.toMatchObject({ status: 401, message: "Unauthorized" } satisfies Partial<ApiError>);
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(API_UNAUTHORIZED_EVENT, listener);
  });
});

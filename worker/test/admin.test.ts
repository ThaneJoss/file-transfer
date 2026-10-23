import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/types";
import type { UsageSummaryResponse } from "../src/usage";
import { bindings, registerUser, request } from "./support";

const { default: app } = await import("../src/index");

function adminRequest(path: string, init: RequestInit = {}) {
  return request(path, init);
}

describe("admin page and API", () => {
  it("serves the admin page on the Access-protected app hostname", async () => {
    const response = await adminRequest("/admin/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain("File Transfer 管理");
  });

  it("blocks admin pages and quota changes on legacy, preview, and unrelated hostnames", async () => {
    for (const origin of [
      "https://api.file.thanejoss.com",
      "https://file-transfer.thanejoss.workers.dev",
      "https://unrelated.example",
    ]) {
      for (const [path, method] of [
        ["/admin", "GET"],
        ["/admin/", "GET"],
        ["/admin/admin.js", "GET"],
        ["/admin/admin.css", "GET"],
        ["/admin/api/stats", "GET"],
        ["/admin/api/users", "GET"],
        ["/admin/api/users/test/quota", "PUT"],
      ]) {
        const response = await request(path, { method }, undefined, origin);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found" });
      }
    }
  });

  it("does not enable the local admin exception with production bindings", async () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const response = await request("/admin/api/users", {}, undefined, origin);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  });

  it("allows loopback admin requests when the app is configured for local development", async () => {
    const localBindings = {
      ...bindings,
      // Wrangler types use the production literal; local dev vars override it.
      APP_ORIGIN: "http://localhost:5173" as Bindings["APP_ORIGIN"],
    };
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const response = await app.fetch(new Request(`${origin}/admin/`), localBindings);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("File Transfer 管理");
    }
  });

  it("aggregates usage and updates a user quota", async () => {
    const account = await registerUser("Admin Quota");
    const now = Math.floor(Date.now() / 1000);
    await bindings.DB.prepare(
      `INSERT INTO usage_event
         (id, user_id, service, action, quantity, unit, metadata, created_at)
       VALUES (?, ?, 'stun', 'stun.transfer.bytes', 4096, 'bytes', '{}', ?)`,
    )
      .bind(crypto.randomUUID(), account.user.id, now)
      .run();

    const from = new Date((now - 60) * 1000).toISOString();
    const to = new Date((now + 60) * 1000).toISOString();
    const statsResponse = await adminRequest(
      `/admin/api/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=hour`,
    );
    expect(statsResponse.status).toBe(200);
    const stats = await statsResponse.json<{
      byCategory: Array<{ service: string; quantity: number }>;
      byUser: Array<{ user_id: string; service: string; quantity: number }>;
    }>();
    expect(stats.byCategory).toContainEqual(expect.objectContaining({ service: "stun", quantity: 4096 }));
    expect(stats.byUser).toContainEqual(
      expect.objectContaining({ user_id: account.user.id, service: "stun", quantity: 4096 }),
    );

    const quotaResponse = await adminRequest(`/admin/api/users/${account.user.id}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "stun", limit: 8192 }),
    });
    expect(quotaResponse.status).toBe(200);
    expect(await quotaResponse.json()).toMatchObject({ service: "stun", unit: "bytes", limit: 8192 });

    const usageResponse = await request("/v1/usage", {}, account.jar);
    const usage = await usageResponse.json<UsageSummaryResponse>();
    expect(usage.summary.find((item) => item.service === "stun")).toMatchObject({
      usage: 4096,
      quota: 8192,
      bytes: 4096,
      quotaBytes: 8192,
    });
  });
});

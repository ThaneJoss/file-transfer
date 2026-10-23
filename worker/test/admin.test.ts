import { describe, expect, it } from "vitest";
import type { UsageSummaryResponse } from "../src/usage";
import { bindings, registerUser, request } from "./support";

function adminRequest(path: string, init: RequestInit = {}) {
  return request(path, init, undefined, "https://api.file.thanejoss.com");
}

describe("admin page and API", () => {
  it("serves the admin page only through its Access-protected hostname", async () => {
    const response = await adminRequest("/admin/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await response.text()).toContain("File Transfer 管理");
  });

  it("blocks admin pages and quota changes on app and preview hostnames", async () => {
    for (const origin of ["https://file.thanejoss.com", "https://file-transfer.thanejoss.workers.dev"]) {
      for (const [path, method] of [["/admin", "GET"], ["/admin/", "GET"], ["/admin/admin.js", "GET"], ["/admin/api/users", "GET"], ["/admin/api/users/test/quota", "PUT"]]) {
        const response = await request(path, { method }, undefined, origin);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found" });
      }
    }
  });

  it("does not enable the local admin exception with production bindings", async () => {
    const response = await request("/admin/api/users", {}, undefined, "http://localhost:8787");
    expect(response.status).toBe(404);
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

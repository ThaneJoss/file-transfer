import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { API_USAGE_CHANGED_EVENT } from "../../../lib/api/client";
import { server } from "../../../test/mocks/server";
import { reportVerifiedTransferUsage } from "./transferUsage";

describe("verified transfer usage", () => {
  it("reports the verified winner with a stable idempotency key input", async () => {
    const usageChanged = vi.fn();
    window.addEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
    server.use(
      http.post("https://api.file.thanejoss.com/v1/usage/transfers", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(await request.json()).toEqual({
          service: "sfu",
          bytes: 12345,
          transferId: "2fb5a6d7-22f4-4cc7-b857-20edb5a60bcb",
        });
        return HttpResponse.json({ recorded: true }, { status: 201 });
      }),
    );

    await expect(reportVerifiedTransferUsage({
      service: "sfu",
      bytes: 12345,
      transferId: "2fb5a6d7-22f4-4cc7-b857-20edb5a60bcb",
    })).resolves.toBe(true);
    expect(usageChanged).toHaveBeenCalledOnce();
    window.removeEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
  });

  it("does not fail a completed transfer when usage reporting fails", async () => {
    const usageChanged = vi.fn();
    window.addEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
    server.use(
      http.post("https://api.file.thanejoss.com/v1/usage/transfers", () =>
        HttpResponse.json({ error: "temporarily unavailable" }, { status: 503 }),
      ),
    );

    await expect(reportVerifiedTransferUsage({
      service: "r2",
      bytes: 99,
      transferId: "93bc9a49-b0ed-4aa3-9afe-25df08206b47",
    })).resolves.toBe(false);
    expect(usageChanged).not.toHaveBeenCalled();
    window.removeEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
  });
});

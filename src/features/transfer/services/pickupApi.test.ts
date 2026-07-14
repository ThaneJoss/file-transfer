import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { API_USAGE_CHANGED_EVENT } from "../../../lib/api/client";
import { server } from "../../../test/mocks/server";
import { createPickup, getPickup } from "./pickupApi";

describe("pickup API service", () => {
  it("creates and resolves a file pickup with session cookies", async () => {
    const usageChanged = vi.fn();
    window.addEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
    server.use(
      http.post("https://api.file.thanejoss.com/v1/pickups", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(await request.json()).toEqual({ variant: "r2", offer: "offer" });
        return HttpResponse.json({ code: "12345678", expiresAt: 123 }, { status: 201 });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678", () =>
        HttpResponse.json({ status: "found", variant: "r2", offer: "offer", expiresAt: 123, answered: false }),
      ),
    );

    await expect(createPickup("offer")).resolves.toEqual({ code: "12345678", expiresAt: 123 });
    await expect(getPickup("12345678")).resolves.toMatchObject({ variant: "r2", offer: "offer" });
    expect(usageChanged).toHaveBeenCalledTimes(2);
    window.removeEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
  });
});

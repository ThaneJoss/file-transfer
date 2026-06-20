import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { API_USAGE_CHANGED_EVENT } from "../../../lib/api/client";
import { server } from "../../../test/mocks/server";
import {
  createPickup,
  getPickup,
  getPickupAnswer,
  recordTransferUsage,
  submitPickupAnswer,
} from "./pickupApi";

describe("pickup API service", () => {
  it("creates and resolves pickup signaling with session cookies", async () => {
    const usageChanged = vi.fn();
    window.addEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
    server.use(
      http.post("https://api.file.thanejoss.com/v1/pickups", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(await request.json()).toEqual({ variant: "direct", offer: "offer" });
        return HttpResponse.json({ code: "12345678", expiresAt: 123 }, { status: 201 });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678", () =>
        HttpResponse.json({ status: "found", variant: "direct", offer: "offer", expiresAt: 123, answered: false }),
      ),
      http.put("https://api.file.thanejoss.com/v1/pickups/12345678/answer", async ({ request }) => {
        expect(await request.json()).toEqual({ answer: "answer" });
        return HttpResponse.json({ accepted: true });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678/answer", () =>
        HttpResponse.json({ answer: "answer" }),
      ),
    );

    await expect(createPickup("direct", "offer")).resolves.toEqual({ code: "12345678", expiresAt: 123 });
    await expect(getPickup("12345678")).resolves.toMatchObject({ variant: "direct", offer: "offer" });
    await expect(submitPickupAnswer("12345678", "answer")).resolves.toEqual({ accepted: true });
    await expect(getPickupAnswer("12345678")).resolves.toEqual({ answer: "answer" });
    expect(usageChanged).toHaveBeenCalledTimes(3);
    window.removeEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
  });

  it("reports completed transfer bytes with an idempotency identifier", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/usage/transfers", async ({ request }) => {
        expect(await request.json()).toEqual({ service: "stun", bytes: 4096, transferId: "transfer-identifier" });
        return HttpResponse.json({ recorded: true }, { status: 201 });
      }),
    );
    await expect(recordTransferUsage("stun", 4096, "transfer-identifier")).resolves.toEqual({ recorded: true });
  });
});

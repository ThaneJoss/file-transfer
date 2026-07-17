import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { API_USAGE_CHANGED_EVENT, clearPickupGuestAuth } from "../../../lib/api/client";
import { server } from "../../../test/mocks/server";
import {
  cancelPickup,
  createPickup,
  getPickup,
  getPickupAnswer,
  getPickupStatus,
  monitorPickupCancellation,
  pollPickupSelection,
  publishPickupOffer,
  reservePickup,
  waitForPickupOffer,
} from "./pickupApi";

describe("pickup API service", () => {
  it("creates and resolves a file pickup with session cookies", async () => {
    const usageChanged = vi.fn();
    window.addEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
    server.use(
      http.post("https://api.file.thanejoss.com/v1/pickups", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(await request.json()).toEqual({ variant: "multipath", offer: "offer" });
        return HttpResponse.json({ code: "12345678", expiresAt: 123 }, { status: 201 });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678", () =>
        HttpResponse.json({ status: "found", variant: "multipath", offer: "offer", expiresAt: 123, answered: false }),
      ),
    );

    await expect(createPickup("offer")).resolves.toEqual({ code: "12345678", expiresAt: 123 });
    await expect(getPickup("12345678")).resolves.toMatchObject({ variant: "multipath", offer: "offer" });
    expect(usageChanged).toHaveBeenCalledTimes(2);
    window.removeEventListener(API_USAGE_CHANGED_EVENT, usageChanged);
  });

  it("treats a null answer as pending data instead of a string", async () => {
    server.use(
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678/answer", () =>
        HttpResponse.json({ answer: null }),
      ),
    );
    await expect(getPickupAnswer("12345678")).resolves.toBeNull();
  });

  it("reserves a code immediately, publishes its offer, and waits through pending state", async () => {
    let lookups = 0;
    const onPending = vi.fn();
    server.use(
      http.post("https://api.file.thanejoss.com/v1/pickups", async ({ request }) => {
        expect(await request.json()).toEqual({ variant: "multipath" });
        return HttpResponse.json({ code: "12345678", expiresAt: Date.now() + 60_000 }, { status: 201 });
      }),
      http.put("https://api.file.thanejoss.com/v1/pickups/12345678/offer", async ({ request }) => {
        expect(await request.json()).toEqual({ offer: "ready-offer" });
        return HttpResponse.json({ accepted: true });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678", () => {
        lookups += 1;
        return lookups === 1
          ? HttpResponse.json({ status: "pending", variant: "multipath", expiresAt: Date.now() + 60_000 }, { status: 202 })
          : HttpResponse.json({
              status: "found",
              variant: "multipath",
              offer: "ready-offer",
              expiresAt: Date.now() + 60_000,
              answered: false,
            });
      }),
    );

    await expect(reservePickup()).resolves.toMatchObject({ code: "12345678" });
    await expect(publishPickupOffer("12345678", "ready-offer")).resolves.toEqual({ accepted: true });
    await expect(waitForPickupOffer("12345678", undefined, { onPending, intervalMs: 0 })).resolves.toMatchObject({
      status: "found",
      offer: "ready-offer",
    });
    expect(onPending).toHaveBeenCalledOnce();
    expect(lookups).toBe(2);
  });

  it("stops coordination polling when the pickup deadline has passed", async () => {
    await expect(pollPickupSelection("12345678", new AbortController().signal, Date.now() - 1)).rejects.toThrow(
      "取件码已经过期",
    );
  });

  it("retries a transient coordination failure", async () => {
    let requests = 0;
    server.use(
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678/selection", () => {
        requests += 1;
        return requests === 1
          ? HttpResponse.json({ error: "temporarily unavailable" }, { status: 503 })
          : HttpResponse.json({ route: "direct" });
      }),
    );

    await expect(
      pollPickupSelection("12345678", new AbortController().signal, Date.now() + 10_000),
    ).resolves.toEqual({ route: "direct" });
    expect(requests).toBe(2);
  });

  it("coordinates cancellation and validates status data", async () => {
    server.use(
      http.put("https://api.file.thanejoss.com/v1/pickups/12345678/cancel", async ({ request }) => {
        expect(await request.json()).toEqual({});
        return HttpResponse.json({ cancelled: true });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678/status", () =>
        HttpResponse.json({ cancelled: false, expiresAt: Date.now() + 60_000 }),
      ),
    );
    await expect(cancelPickup("12345678")).resolves.toEqual({ cancelled: true });
    await expect(getPickupStatus("12345678")).resolves.toMatchObject({ cancelled: false });
  });

  it("turns a remote cancellation into a user-facing coordination error", async () => {
    server.use(
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678/status", () =>
        HttpResponse.json({ cancelled: true, expiresAt: Date.now() + 60_000 }),
      ),
    );
    await expect(
      monitorPickupCancellation("12345678", new AbortController().signal, Date.now() + 60_000),
    ).rejects.toThrow("另一端已取消传输");
  });

  it("claims one pickup for a guest and scopes subsequent coordination with its token", async () => {
    const expiresAt = Date.now() + 60_000;
    server.use(
      http.post("https://api.file.thanejoss.com/v1/pickups/12345678/guest", async ({ request }) => {
        expect(await request.json()).toEqual({});
        expect(request.headers.get("x-pickup-guest-token")).toBeNull();
        return HttpResponse.json({
          token: "guest-token",
          expiresAt,
          pickup: {
            status: "found",
            variant: "multipath",
            offer: "guest-offer",
            expiresAt,
            answered: false,
          },
        }, { status: 201 });
      }),
      http.get("https://api.file.thanejoss.com/v1/pickups/12345678/status", ({ request }) => {
        expect(request.headers.get("x-pickup-guest-token")).toBe("guest-token");
        expect(new URL(request.url).searchParams.get("wait")).toBe("20000");
        return HttpResponse.json({ cancelled: false, expiresAt });
      }),
    );

    try {
      await expect(waitForPickupOffer("12345678", undefined, { allowGuest: true })).resolves.toMatchObject({
        offer: "guest-offer",
      });
      await expect(getPickupStatus("12345678", undefined, 20_000)).resolves.toEqual({ cancelled: false, expiresAt });
    } finally {
      clearPickupGuestAuth();
    }
  });
});

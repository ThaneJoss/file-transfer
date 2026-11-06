import { describe, expect, it } from "vitest";
import { bindings, registerUser, request } from "./support";

async function selectedPickup() {
  const stub = bindings.PICKUP_SESSIONS.getByName(crypto.randomUUID());
  await stub.reserve({
    senderUserId: "sender",
    variant: "multipath",
    offer: "offer",
    expiresAt: Date.now() + 60_000,
  });
  await stub.submitAnswer("receiver", "answer");
  await stub.submitSelection("sender", "direct");
  return stub;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("selection change cursors", () => {
  it("waits after the first selection, ignores idempotent writes and wakes on fallback", async () => {
    const stub = await selectedPickup();
    expect(await stub.getSelection("receiver")).toEqual({ status: "found", route: "direct", version: 1 });
    let returned = false;
    const waiting = stub.getSelection("receiver", 5_000, 1).then((result) => {
      returned = true;
      return result;
    });
    await pause(30);
    expect(returned).toBe(false);
    await stub.submitSelection("sender", "direct");
    await pause(30);
    expect(returned).toBe(false);
    await stub.submitSelection("sender", "r2");
    expect(await waiting).toEqual({ status: "found", route: "r2", version: 2 });
    expect(await stub.getSelection("receiver", 5_000, 1)).toEqual({ status: "found", route: "r2", version: 2 });
  });

  it("returns the unchanged snapshot when the wait expires", async () => {
    const stub = await selectedPickup();
    expect(await stub.getSelection("receiver", 25, 1)).toEqual({ status: "found", route: "direct", version: 1 });
  });

  it("wakes a cursor wait on cancellation and keeps receiver authorization", async () => {
    const stub = await selectedPickup();
    expect(await stub.getSelection("outsider", 5_000, 1)).toEqual({ status: "forbidden" });
    const waiting = stub.getSelection("receiver", 5_000, 1);
    await pause(20);
    await stub.cancel("sender");
    expect(await waiting).toEqual({ status: "cancelled" });
  });

  it("rejects malformed HTTP cursors before consulting the pickup", async () => {
    const user = await registerUser("Selection Cursor");
    for (const after of ["-1", "1.5", "NaN", "", "9007199254740992"]) {
      const response = await request(`/v1/pickups/12345678/selection?after=${encodeURIComponent(after)}`, {}, user.jar);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "after must be a non-negative safe integer" });
    }
  });
});

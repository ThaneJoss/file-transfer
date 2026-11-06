import { afterEach, describe, expect, it, vi } from "vitest";
import { bindings, registerUser, request } from "./support";
import type { CookieJar } from "./support";

type Actor = { jar?: CookieJar; token?: string };

afterEach(() => vi.restoreAllMocks());

function mockSfu() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/rtc\.live\.cloudflare\.com\/v1\/apps\/test\/sessions\//);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test");
    return Response.json(
      String(input).endsWith("/sessions/new")
        ? { sessionId: crypto.randomUUID() }
        : { dataChannels: [{ id: 0 }] },
      { status: String(input).endsWith("/sessions/new") ? 201 : 200 },
    );
  });
}

async function createPickup(sender: Actor, offer?: string) {
  const response = await request("/v1/pickups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variant: "multipath", ...(offer === undefined ? {} : { offer }) }),
  }, sender.jar);
  expect(response.status).toBe(201);
  return response.json<{ code: string; expiresAt: number }>();
}

async function claim(code: string): Promise<Actor> {
  const response = await request(`/v1/pickups/${code}/guest`, { method: "POST" });
  expect(response.status).toBe(201);
  const { token } = await response.json<{ token: string }>();
  return { token };
}

function sfuRequest(code: string, path: string, actor: Actor, body?: unknown, method = "POST") {
  return request(`/v1/sfu${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Pickup-Code": code,
      ...(actor.token ? { "X-Pickup-Guest-Token": actor.token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, actor.jar);
}

async function createSession(code: string, actor: Actor) {
  const response = await sfuRequest(code, "/sessions/new", actor);
  expect(response.status).toBe(201);
  return (await response.json<{ sessionId: string }>()).sessionId;
}

function answer(code: string, actor: Actor) {
  return request(`/v1/pickups/${code}/answer`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(actor.token ? { "X-Pickup-Guest-Token": actor.token } : {}),
    },
    body: JSON.stringify({ answer: "receiver-answer" }),
  }, actor.jar);
}

const remoteChannel = (sessionId: string) => ({
  location: "remote",
  sessionId,
  dataChannelName: "file-data",
  waitForAck: true,
});

describe("pickup-scoped SFU sessions", () => {
  it("allows sender preparation and the receiver's full duplex handshake before and after Answer binding", async () => {
    const sender = await registerUser("SFU Sender");
    const pickup = await createPickup(sender);
    const upstream = mockSfu();
    const senderSession = await createSession(pickup.code, sender);
    const receiver = await claim(pickup.code);

    expect((await sfuRequest(pickup.code, "/sessions/new", receiver)).status).toBe(409);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await request(`/v1/pickups/${pickup.code}/offer`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offer: "published-sfu-offer" }),
    }, sender.jar)).status).toBe(200);

    const receiverSession = await createSession(pickup.code, receiver);
    expect((await sfuRequest(pickup.code, `/sessions/${receiverSession}/datachannels/establish`, receiver, {
      dataChannel: { location: "remote", dataChannelName: "server-events" },
      sessionDescription: { type: "offer", sdp: "test-offer" },
    })).status).toBe(200);
    for (const [actor, sessionId] of [[sender, senderSession], [receiver, receiverSession]] as const) {
      expect((await sfuRequest(pickup.code, `/sessions/${sessionId}/datachannels/new`, actor, {
        dataChannels: [{ location: "local", dataChannelName: "file-data" }],
      })).status).toBe(200);
    }
    expect((await sfuRequest(pickup.code, `/sessions/${receiverSession}/datachannels/new`, receiver, {
      dataChannels: [remoteChannel(senderSession)],
    })).status).toBe(200);
    expect((await answer(pickup.code, receiver)).status).toBe(200);
    expect((await sfuRequest(pickup.code, `/sessions/${senderSession}/datachannels/new`, sender, {
      dataChannels: [remoteChannel(receiverSession)],
    })).status).toBe(200);
    expect((await sfuRequest(pickup.code, `/sessions/${senderSession}/renegotiate`, sender, {
      sessionDescription: { type: "answer", sdp: "test-answer" },
    }, "PUT")).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(8);
  });

  it("keeps same-account receiving available before Answer binding", async () => {
    const user = await registerUser("SFU Same Account");
    const pickup = await createPickup(user, "same-account-offer");
    const upstream = mockSfu();
    const senderSession = await createSession(pickup.code, user);
    const receiverSession = await createSession(pickup.code, user);
    expect((await sfuRequest(pickup.code, `/sessions/${receiverSession}/datachannels/new`, user, {
      dataChannels: [remoteChannel(senderSession)],
    })).status).toBe(200);
    expect((await answer(pickup.code, user)).status).toBe(200);
    expect((await sfuRequest(pickup.code, `/sessions/${senderSession}/datachannels/new`, user, {
      dataChannels: [remoteChannel(receiverSession)],
    })).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("rejects missing scope, other owners, cross-pickup targets and every foreign source in a batch before calling SFU", async () => {
    const sender = await registerUser("SFU Scope Sender");
    const first = await createPickup(sender, "first-offer");
    const second = await createPickup(sender, "second-offer");
    const upstream = mockSfu();
    const firstSession = await createSession(first.code, sender);
    const secondSession = await createSession(second.code, sender);
    const receiver = await claim(first.code);
    const receiverSession = await createSession(first.code, receiver);
    const forwarded = upstream.mock.calls.length;

    expect((await request("/v1/sfu/sessions/new", {
      method: "POST", headers: { "Content-Type": "application/json" },
    }, sender.jar)).status).toBe(400);
    expect((await sfuRequest(second.code, "/sessions/new", receiver)).status).toBe(403);
    expect((await sfuRequest(first.code, `/sessions/${firstSession}/renegotiate`, receiver, {}, "PUT")).status).toBe(403);
    expect((await sfuRequest(first.code, `/sessions/${secondSession}/datachannels/new`, sender, {
      dataChannels: [{ location: "local", dataChannelName: "file-data" }],
    })).status).toBe(403);
    expect((await sfuRequest(first.code, `/sessions/${receiverSession}/datachannels/new`, receiver, {
      dataChannels: [remoteChannel(firstSession), remoteChannel(secondSession)],
    })).status).toBe(403);
    expect((await sfuRequest(first.code, `/sessions/${receiverSession}/datachannels/new`, receiver, {
      dataChannels: [remoteChannel("unregistered-session")],
    })).status).toBe(403);
    expect((await sfuRequest(first.code, `/sessions/${receiverSession}/datachannels/new`, receiver, {
      dataChannels: [{ ...remoteChannel(firstSession), sessionId: 42 }],
    })).status).toBe(400);
    for (const channel of [
      { location: "remote", dataChannelName: "file-data" },
      { ...remoteChannel(firstSession), location: "unexpected" },
      { ...remoteChannel(firstSession), location: "local" },
    ]) {
      expect((await sfuRequest(first.code, `/sessions/${receiverSession}/datachannels/new`, receiver, {
        dataChannels: [channel],
      })).status).toBe(400);
    }
    expect(upstream).toHaveBeenCalledTimes(forwarded);
  });

  it("revokes losing receiver candidates, including their previously registered sessions", async () => {
    const sender = await registerUser("SFU Candidate Sender");
    const pickup = await createPickup(sender, "candidate-offer");
    const upstream = mockSfu();
    const senderSession = await createSession(pickup.code, sender);
    const receiver = await claim(pickup.code);
    const outsider = await claim(pickup.code);
    const receiverSession = await createSession(pickup.code, receiver);
    const outsiderSession = await createSession(pickup.code, outsider);
    expect((await answer(pickup.code, receiver)).status).toBe(200);
    const forwarded = upstream.mock.calls.length;

    expect((await sfuRequest(pickup.code, "/sessions/new", outsider)).status).toBe(403);
    expect((await sfuRequest(pickup.code, `/sessions/${outsiderSession}/datachannels/new`, outsider, {
      dataChannels: [remoteChannel(senderSession)],
    })).status).toBe(403);
    expect((await sfuRequest(pickup.code, `/sessions/${senderSession}/datachannels/new`, sender, {
      dataChannels: [remoteChannel(outsiderSession)],
    })).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(forwarded);
    expect((await sfuRequest(pickup.code, `/sessions/${receiverSession}/datachannels/new`, receiver, {
      dataChannels: [remoteChannel(senderSession)],
    })).status).toBe(200);
  });

  it("rejects cancelled or expired pickups and rechecks access after upstream session creation", async () => {
    const sender = await registerUser("SFU Lifecycle Sender");
    const cancelled = await createPickup(sender, "cancelled-offer");
    const upstream = mockSfu();
    const sessionId = await createSession(cancelled.code, sender);
    expect((await request(`/v1/pickups/${cancelled.code}/cancel`, { method: "PUT" }, sender.jar)).status).toBe(200);
    expect((await sfuRequest(cancelled.code, `/sessions/${sessionId}/renegotiate`, sender, {}, "PUT")).status).toBe(410);

    const expiredCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000).padStart(8, "0");
    const expired = bindings.PICKUP_SESSIONS.getByName(expiredCode);
    expect(await expired.reserve({
      senderUserId: sender.user.id, variant: "multipath", offer: "expired", expiresAt: Date.now() - 1,
    })).toBe(true);
    expect((await sfuRequest(expiredCode, "/sessions/new", sender)).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);

    const racing = await createPickup(sender, "racing-offer");
    upstream.mockImplementationOnce(async () => {
      expect((await request(`/v1/pickups/${racing.code}/cancel`, { method: "PUT" }, sender.jar)).status).toBe(200);
      return Response.json({ sessionId: "created-after-cancellation" }, { status: 201 });
    });
    expect((await sfuRequest(racing.code, "/sessions/new", sender)).status).toBe(410);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

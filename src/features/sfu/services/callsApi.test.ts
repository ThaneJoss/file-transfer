import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/mocks/server";
import {
  callsFetch,
  createCallsSession,
  createPublisherChannel,
  createSubscriberChannel,
  establishDataChannelTransport,
} from "./callsApi";

describe("Cloudflare Calls API client", () => {
  it("uses the authenticated backend proxy without exposing an API token", async () => {
    const peerConnection = {} as RTCPeerConnection;
    server.use(
      http.post(`${window.location.origin}/v1/sfu/sessions/new`, ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(request.headers.get("x-pickup-code")).toBe("12345678");
        return HttpResponse.json({ sessionId: "publisher-1" });
      }),
    );

    await expect(createCallsSession(peerConnection, { pickupCode: "12345678" })).resolves.toEqual({
      id: "publisher-1",
      pickupCode: "12345678",
      peerConnection,
    });
  });

  it("sends distinct publisher and subscriber DataChannel contracts", async () => {
    const requests: unknown[] = [];
    const created: Array<{ label: string; options?: RTCDataChannelInit }> = [];
    const peerConnection = {
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        created.push({ label, options });
        return { label } as RTCDataChannel;
      },
    } as RTCPeerConnection;
    const session = { id: "subscriber-1", pickupCode: "12345678", peerConnection };

    server.use(
      http.post(`${window.location.origin}/v1/sfu/sessions/subscriber-1/datachannels/new`, async ({ request }) => {
        expect(request.headers.get("x-pickup-code")).toBe(session.pickupCode);
        requests.push(await request.json());
        return HttpResponse.json({ dataChannels: [{ id: 19 }] });
      }),
    );

    await createPublisherChannel(session, "file-main");
    await createSubscriberChannel(session, "publisher-1", "file-main");

    expect(requests).toEqual([
      {
        dataChannels: [{ location: "local", dataChannelName: "file-main" }],
      },
      {
        dataChannels: [
          {
            location: "remote",
            sessionId: "publisher-1",
            dataChannelName: "file-main",
            waitForAck: true,
          },
        ],
      },
    ]);
    expect(created).toEqual([
      { label: "file-main", options: { negotiated: true, id: 19 } },
      { label: "file-main-subscribed", options: { negotiated: true, id: 19 } },
    ]);
  });

  it("preserves cancellation as AbortError", async () => {
    server.use(
      http.post(`${window.location.origin}/v1/sfu/sessions/new`, async () => {
        await delay("infinite");
        return HttpResponse.json({ sessionId: "too-late" });
      }),
    );
    const controller = new AbortController();
    const request = callsFetch("/sessions/new", { method: "POST" }, { pickupCode: "12345678", signal: controller.signal });
    controller.abort("test cancellation");

    await expect(request).rejects.toMatchObject({
      name: "AbortError",
      message: "Cloudflare SFU 请求已取消。",
    });
  });

  it("reports a bounded request timeout", async () => {
    server.use(
      http.post(`${window.location.origin}/v1/sfu/sessions/new`, async () => {
        await delay(50);
        return HttpResponse.json({ sessionId: "too-late" });
      }),
    );

    await expect(
      callsFetch("/sessions/new", { method: "POST" }, { pickupCode: "12345678", timeoutMs: 5 }),
    ).rejects.toThrow("Cloudflare SFU 请求超时（5ms）");
  });

  it.each(["", "1234567", "123456789", "abcdefgh"])("rejects invalid pickup scope %j before fetching", async (pickupCode) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(callsFetch("/sessions/new", { method: "POST" }, { pickupCode }))
        .rejects.toThrow("8 位取件码");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("retains separate pickup scopes across concurrent sessions", async () => {
    const requests: Array<{ sessionId: string; pickupCode: string | null }> = [];
    const peerConnection = {
      createDataChannel: (label: string) => ({ label }) as RTCDataChannel,
    } as RTCPeerConnection;
    server.use(
      http.post(`${window.location.origin}/v1/sfu/sessions/new`, ({ request }) =>
        HttpResponse.json({ sessionId: `session-${request.headers.get("x-pickup-code")}` }),
      ),
      http.post(`${window.location.origin}/v1/sfu/sessions/:sessionId/datachannels/new`, ({ request, params }) => {
        requests.push({ sessionId: String(params.sessionId), pickupCode: request.headers.get("x-pickup-code") });
        return HttpResponse.json({ dataChannels: [{ id: 19 }] });
      }),
    );
    const sessions = await Promise.all(["12345678", "87654321"].map((pickupCode) =>
      createCallsSession(peerConnection, { pickupCode }),
    ));
    await Promise.all(sessions.map((session) => createPublisherChannel(session, "file-main")));
    expect(requests).toHaveLength(2);
    expect(requests).toEqual(expect.arrayContaining([
      { sessionId: "session-12345678", pickupCode: "12345678" },
      { sessionId: "session-87654321", pickupCode: "87654321" },
    ]));
  });

  it("preserves the session pickup scope through transport renegotiation", async () => {
    const scopes: Array<string | null> = [];
    const peerConnection = {
      createDataChannel: () => new EventTarget() as RTCDataChannel,
      createOffer: async () => ({ type: "offer", sdp: "offer" }),
      createAnswer: async () => ({ type: "answer", sdp: "answer" }),
      setLocalDescription: async () => undefined,
      setRemoteDescription: async () => undefined,
      localDescription: null,
    } as unknown as RTCPeerConnection;
    const session = { id: "renegotiate-1", pickupCode: "12345678", peerConnection };
    server.use(
      http.post(`${window.location.origin}/v1/sfu/sessions/renegotiate-1/datachannels/establish`, ({ request }) => {
        scopes.push(request.headers.get("x-pickup-code"));
        return HttpResponse.json({
          sessionDescription: { type: "offer", sdp: "cloudflare-offer" },
          requiresImmediateRenegotiation: true,
        });
      }),
      http.put(`${window.location.origin}/v1/sfu/sessions/renegotiate-1/renegotiate`, ({ request }) => {
        scopes.push(request.headers.get("x-pickup-code"));
        return HttpResponse.json({});
      }),
    );
    await establishDataChannelTransport(session);
    expect(scopes).toEqual(["12345678", "12345678"]);
  });
});

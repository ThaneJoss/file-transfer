import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import {
  callsFetch,
  createCallsSession,
  createPublisherChannel,
  createSubscriberChannel,
} from "./callsApi";

describe("Cloudflare Calls API client", () => {
  it("uses the authenticated backend proxy without exposing an API token", async () => {
    const peerConnection = {} as RTCPeerConnection;
    server.use(
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/new", ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("content-type")).toBe("application/json");
        return HttpResponse.json({ sessionId: "publisher-1" });
      }),
    );

    await expect(createCallsSession(peerConnection)).resolves.toEqual({
      id: "publisher-1",
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
    const session = { id: "subscriber-1", peerConnection };

    server.use(
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/subscriber-1/datachannels/new", async ({ request }) => {
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
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/new", async () => {
        await delay("infinite");
        return HttpResponse.json({ sessionId: "too-late" });
      }),
    );
    const controller = new AbortController();
    const request = callsFetch("/sessions/new", { method: "POST" }, { signal: controller.signal });
    controller.abort("test cancellation");

    await expect(request).rejects.toMatchObject({
      name: "AbortError",
      message: "Cloudflare SFU 请求已取消。",
    });
  });

  it("reports a bounded request timeout", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/new", async () => {
        await delay(50);
        return HttpResponse.json({ sessionId: "too-late" });
      }),
    );

    await expect(
      callsFetch("/sessions/new", { method: "POST" }, { timeoutMs: 5 }),
    ).rejects.toThrow("Cloudflare SFU 请求超时（5ms）");
  });
});

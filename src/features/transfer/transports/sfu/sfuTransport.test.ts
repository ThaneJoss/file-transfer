import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../test/mocks/server";
import {
  prepareSfuReceiver,
  prepareSfuSender,
  sfuReceiverDescriptorKind,
  sfuSenderDescriptorKind,
} from "./sfuTransport";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  id = 7;
  maxPacketLifeTime: number | null = null;
  maxRetransmits: number | null = null;
  negotiated = true;
  ordered = true;
  protocol = "";
  readyState: RTCDataChannelState = "connecting";
  closeCalls = 0;
  readonly sendCalls: unknown[] = [];

  constructor(readonly label: string) {
    super();
  }

  open() {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  send(data: unknown) {
    if (this.readyState !== "open") throw new DOMException("not open", "InvalidStateError");
    this.sendCalls.push(data);
  }

  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close() {
    this.closeCalls += 1;
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  closeCalls = 0;
  readonly channels: FakeDataChannel[] = [];

  constructor(private readonly autoOpen = true) {
    super();
  }

  createDataChannel(label: string) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    if (this.autoOpen) queueMicrotask(() => channel.open());
    return channel as unknown as RTCDataChannel;
  }

  async createOffer() {
    return { type: "offer", sdp: "local-offer" } as RTCSessionDescriptionInit;
  }

  async setLocalDescription(description: RTCLocalSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description as RTCSessionDescription;
  }

  close() {
    this.closeCalls += 1;
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  channel(label: string) {
    const channel = this.channels.find((candidate) => candidate.label === label);
    if (!channel) throw new Error(`Missing fake channel: ${label}`);
    return channel;
  }
}

describe("SFU duplex transport session", () => {
  let nextSession: number;
  let nextChannelId: number;
  const channelRequests: unknown[] = [];

  beforeEach(() => {
    vi.useRealTimers();
    nextSession = 0;
    nextChannelId = 0;
    channelRequests.length = 0;
    server.use(
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/new", () =>
        HttpResponse.json({ sessionId: `session-${++nextSession}` }),
      ),
      http.post(/https:\/\/api\.file\.thanejoss\.com\/v1\/sfu\/sessions\/[^/]+\/datachannels\/establish/, () =>
        HttpResponse.json({
          sessionDescription: { type: "answer", sdp: "cloudflare-answer" },
          requiresImmediateRenegotiation: false,
        }),
      ),
      http.post(/https:\/\/api\.file\.thanejoss\.com\/v1\/sfu\/sessions\/[^/]+\/datachannels\/new/, async ({ request }) => {
        channelRequests.push(await request.json());
        return HttpResponse.json({ dataChannels: [{ id: ++nextChannelId }] });
      }),
    );
  });

  it("builds two one-way channels into a duplex facade in both directions", async () => {
    const senderPeer = new FakePeerConnection();
    const sender = await prepareSfuSender({
      dataChannelName: "file-forward",
      peerConnectionFactory: () => senderPeer as unknown as RTCPeerConnection,
    });
    expect(sender.descriptor).toEqual({
      kind: sfuSenderDescriptorKind,
      publisherSessionId: "session-1",
      dataChannelName: "file-forward",
    });
    expect(sender.channel.readyState).toBe("connecting");

    const receiverPeer = new FakePeerConnection();
    const receiver = await prepareSfuReceiver(sender.descriptor, {
      dataChannelName: "file-reverse",
      peerConnectionFactory: () => receiverPeer as unknown as RTCPeerConnection,
    });
    expect(receiver.answerDescriptor).toEqual({
      kind: sfuReceiverDescriptorKind,
      publisherSessionId: "session-2",
      dataChannelName: "file-reverse",
    });
    await expect(receiver.ready).resolves.toBe(receiver.channel);

    await sender.acceptAnswer(receiver.answerDescriptor);
    await expect(sender.ready).resolves.toBe(sender.channel);
    expect(sender.channel.readyState).toBe("open");
    expect(receiver.channel.readyState).toBe("open");

    const senderForward = senderPeer.channel("file-forward");
    const receiverForward = receiverPeer.channel("file-forward-subscribed");
    const receiverReverse = receiverPeer.channel("file-reverse");
    const senderReverse = senderPeer.channel("file-reverse-subscribed");

    // Every gated remote channel sends ACK before any application frame. The
    // ACK is consumed by Cloudflare and must never appear on the facade.
    expect(receiverForward.sendCalls).toEqual(["ack"]);
    expect(senderReverse.sendCalls).toEqual(["ack"]);

    const receiverMessages: unknown[] = [];
    const senderMessages: unknown[] = [];
    receiver.channel.addEventListener("message", (event) => receiverMessages.push((event as MessageEvent).data));
    sender.channel.addEventListener("message", (event) => senderMessages.push((event as MessageEvent).data));

    sender.channel.send("forward application frame");
    expect(senderForward.sendCalls.at(-1)).toBe("forward application frame");
    receiverForward.receive("forward application frame");
    expect(receiverMessages).toEqual(["forward application frame"]);

    receiver.channel.send("reverse application frame");
    expect(receiverReverse.sendCalls.at(-1)).toBe("reverse application frame");
    senderReverse.receive("reverse application frame");
    expect(senderMessages).toEqual(["reverse application frame"]);

    // The first publisher frame is the transport keepalive. It is internal and
    // cannot be mistaken for a control message by channelTransfer.
    receiverForward.receive(senderForward.sendCalls[0]);
    senderReverse.receive(receiverReverse.sendCalls[0]);
    expect(receiverMessages).toEqual(["forward application frame"]);
    expect(senderMessages).toEqual(["reverse application frame"]);

    expect(channelRequests).toEqual(expect.arrayContaining([
      { dataChannels: [{ location: "local", dataChannelName: "file-forward" }] },
      {
        dataChannels: [{
          location: "remote",
          sessionId: "session-1",
          dataChannelName: "file-forward",
          waitForAck: true,
        }],
      },
      { dataChannels: [{ location: "local", dataChannelName: "file-reverse" }] },
      {
        dataChannels: [{
          location: "remote",
          sessionId: "session-2",
          dataChannelName: "file-reverse",
          waitForAck: true,
        }],
      },
    ]));

    sender.dispose();
    receiver.dispose();
    expect(senderForward.closeCalls).toBe(1);
    expect(senderReverse.closeCalls).toBe(1);
    expect(senderPeer.closeCalls).toBe(1);
    expect(receiverForward.closeCalls).toBe(1);
    expect(receiverReverse.closeCalls).toBe(1);
    expect(receiverPeer.closeCalls).toBe(1);
  }, 20_000);

  it("keeps a waiting publisher alive every ten seconds and clears the timer on dispose", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const peer = new FakePeerConnection();
    const sender = await prepareSfuSender({
      dataChannelName: "file-keepalive",
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
    });
    const forward = peer.channel("file-keepalive");

    expect(forward.sendCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(forward.sendCalls).toHaveLength(4);

    sender.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(forward.sendCalls).toHaveLength(4);
  });

  it("propagates cancellation, closes both sides, and stops keepalive", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = new AbortController();
    const peer = new FakePeerConnection();
    const sender = await prepareSfuSender({
      signal: controller.signal,
      dataChannelName: "file-abort",
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
    });
    const forward = peer.channel("file-abort");
    const beforeAbort = forward.sendCalls.length;

    controller.abort("new transfer started");

    await expect(sender.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(sender.channel.readyState).toBe("closed");
    expect(forward.closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(forward.sendCalls).toHaveLength(beforeAbort);
  });

  it("closes a half-built session when channel readiness times out", async () => {
    const peer = new FakePeerConnection(false);
    await expect(prepareSfuSender({
      timeoutMs: 5,
      dataChannelName: "file-timeout",
      peerConnectionFactory: () => peer as unknown as RTCPeerConnection,
    })).rejects.toThrow("等待 SFU DataChannel 超时（5ms）");

    expect(peer.channel("file-timeout").closeCalls).toBe(1);
    expect(peer.closeCalls).toBe(1);
  });
});

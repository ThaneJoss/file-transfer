import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWebRtcConfiguration,
  createWebRtcReceiverSession,
  createWebRtcSenderSession,
} from "./session";

const host = "candidate:1 1 udp 2122260223 192.168.1.2 5000 typ host generation 0";
const srflx = "candidate:2 1 udp 1686052607 203.0.113.2 6000 typ srflx raddr 192.168.1.2 rport 5000";
const relay = "candidate:3 1 udp 1677734911 198.51.100.2 7000 typ relay raddr 203.0.113.2 rport 6000";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";

  close() {
    this.readyState = "closed";
  }
}

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  readonly channel = new FakeDataChannel();
  readonly addedCandidates: Array<RTCIceCandidateInit | null> = [];

  constructor(
    readonly configuration: RTCConfiguration,
    private readonly finishGathering = true,
  ) {
    super();
  }

  createDataChannel() {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.iceGatheringState = "gathering";
    const candidates = this.configuration.iceTransportPolicy === "relay"
      ? [relay]
      : this.configuration.iceServers?.length
        ? [host, srflx]
        : [host];
    this.localDescription = {
      ...description,
      sdp: `${description.sdp}${candidates.map((candidate) => `a=${candidate}\r\n`).join("")}a=end-of-candidates\r\n`,
      toJSON: () => description,
    } as RTCSessionDescription;

    for (const candidate of candidates) {
      const event = new Event("icecandidate") as RTCPeerConnectionIceEvent;
      Object.defineProperty(event, "candidate", {
        value: { candidate, sdpMid: "0", sdpMLineIndex: 0, toJSON: () => ({ candidate, sdpMid: "0", sdpMLineIndex: 0 }) },
      });
      this.dispatchEvent(event);
    }
    if (this.finishGathering) {
      this.iceGatheringState = "complete";
      this.dispatchEvent(new Event("icegatheringstatechange"));
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = { ...description, toJSON: () => description } as RTCSessionDescription;
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit | null) {
    this.addedCandidates.push(candidate ?? null);
  }

  close() {
    this.connectionState = "closed";
  }
}

function asPeer(peer: FakePeerConnection) {
  return peer as unknown as RTCPeerConnection;
}

describe("WebRTC route sessions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("builds isolated Direct, STUN and relay-only TURN configurations", () => {
    expect(createWebRtcConfiguration("direct")).toEqual({ iceServers: [] });
    expect(createWebRtcConfiguration("stun")).toEqual({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    const turnServers = [{ urls: "turn:example.com", username: "u", credential: "p" }];
    expect(createWebRtcConfiguration("turn", turnServers)).toEqual({
      iceServers: turnServers,
      iceTransportPolicy: "relay",
    });
    expect(() => createWebRtcConfiguration("turn")).toThrow("缺少临时 iceServers");
  });

  it("creates structured offers and answers with only STUN srflx candidates", async () => {
    const peers: FakePeerConnection[] = [];
    const factory = (configuration: RTCConfiguration) => {
      const peer = new FakePeerConnection(configuration);
      peers.push(peer);
      return asPeer(peer);
    };
    const sender = createWebRtcSenderSession({ route: "stun", peerConnectionFactory: factory });
    const receiver = createWebRtcReceiverSession({ route: "stun", peerConnectionFactory: factory });

    const offer = await sender.prepareOffer();
    expect(offer).toMatchObject({
      kind: "file-transfer-webrtc-signal",
      version: 1,
      route: "stun",
      role: "offer",
    });
    expect(offer.candidates).toHaveLength(1);
    expect(offer.candidates[0]?.candidate).toContain("typ srflx");
    expect(offer.description.sdp).not.toContain("typ host");

    const answer = await receiver.acceptOffer(offer);
    expect(answer.role).toBe("answer");
    expect(answer.candidates).toHaveLength(1);
    expect(answer.candidates[0]?.candidate).toContain("typ srflx");
    await sender.applyAnswer(answer);
    expect(peers[0]?.remoteDescription?.type).toBe("answer");
    expect(peers[1]?.remoteDescription?.type).toBe("offer");

    sender.dispose();
    receiver.dispose();
    expect(peers.every((peer) => peer.connectionState === "closed")).toBe(true);
  });

  it("times out candidate gathering and removes its timer", async () => {
    const peer = new FakePeerConnection({ iceServers: [] }, false);
    const sender = createWebRtcSenderSession({
      route: "direct",
      peerConnectionFactory: () => asPeer(peer),
    });
    const result = sender.prepareOffer({ timeoutMs: 100 });
    const assertion = expect(result).rejects.toThrow("ICE candidate 收集超时");

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    sender.dispose();
  });

  it("aborts candidate gathering", async () => {
    const peer = new FakePeerConnection({ iceServers: [] }, false);
    const sender = createWebRtcSenderSession({
      route: "direct",
      peerConnectionFactory: () => asPeer(peer),
    });
    const controller = new AbortController();
    const result = sender.prepareOffer({ timeoutMs: 1_000, signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });

    await Promise.resolve();
    controller.abort(new DOMException("测试取消", "AbortError"));
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    sender.dispose();
  });
});

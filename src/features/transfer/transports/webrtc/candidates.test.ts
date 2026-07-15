import { describe, expect, it } from "vitest";

import {
  createWebRtcSignal,
  filterIceCandidates,
  filterSessionDescriptionCandidates,
  getIceCandidateType,
  sanitizeRemoteSignal,
  summarizeIceCandidates,
} from "./candidates";

const host = "candidate:1 1 udp 2122260223 192.168.1.2 5000 typ host generation 0";
const srflx = "candidate:2 1 udp 1686052607 203.0.113.2 6000 typ srflx raddr 192.168.1.2 rport 5000";
const relay = "candidate:3 1 udp 1677734911 198.51.100.2 7000 typ relay raddr 203.0.113.2 rport 6000";

function description(type: RTCSdpType = "offer"): RTCSessionDescriptionInit {
  return {
    type,
    sdp: `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=${host}\r\na=${srflx}\r\na=${relay}\r\na=end-of-candidates\r\n`,
  };
}

describe("WebRTC candidate routing", () => {
  it("recognizes and filters host, srflx and relay candidates", () => {
    expect(getIceCandidateType(host)).toBe("host");
    expect(getIceCandidateType(srflx)).toBe("srflx");
    expect(getIceCandidateType(relay)).toBe("relay");

    expect(filterIceCandidates([
      { candidate: host },
      { candidate: srflx },
      { candidate: relay },
    ], ["srflx"])).toEqual([{ candidate: srflx }]);

    const filtered = filterSessionDescriptionCandidates(description(), ["relay"]);
    expect(filtered.sdp).toContain(`a=${relay}`);
    expect(filtered.sdp).not.toContain(host);
    expect(filtered.sdp).not.toContain(srflx);
    expect(filtered.sdp).not.toContain("a=end-of-candidates");
  });

  it("emits only the route candidate and keeps explicit candidates", () => {
    const signal = createWebRtcSignal("stun", "offer", description(), [
      { candidate: host, sdpMid: "0", sdpMLineIndex: 0 },
      { candidate: srflx, sdpMid: "0", sdpMLineIndex: 0 },
    ]);

    expect(signal.description.sdp).toContain(srflx);
    expect(signal.description.sdp).not.toContain(host);
    expect(signal.candidates).toEqual([{ candidate: srflx, sdpMid: "0", sdpMLineIndex: 0 }]);
    expect(summarizeIceCandidates(signal.description, signal.candidates)).toEqual({
      host: 0,
      srflx: 1,
      relay: 0,
      total: 1,
    });
  });

  it("reports STUN unavailable instead of falling back to host", () => {
    expect(() => createWebRtcSignal("stun", "offer", {
      type: "offer",
      sdp: `v=0\r\na=${host}\r\n`,
    }, [{ candidate: host }])).toThrow("不会回退到 host 直连");
  });

  it("rejects a mismatched route and sanitizes unexpected candidates", () => {
    const turnSignal = createWebRtcSignal("turn", "answer", { ...description("answer") }, [
      { candidate: relay },
    ]);
    expect(() => sanitizeRemoteSignal(turnSignal, "direct", "answer")).toThrow("信令格式不正确");

    const mixedSignal = {
      ...turnSignal,
      description: description("answer"),
      candidates: [{ candidate: host }, { candidate: relay }],
    };
    const sanitized = sanitizeRemoteSignal(mixedSignal, "turn", "answer");
    expect(sanitized.description.sdp).toContain(relay);
    expect(sanitized.description.sdp).not.toContain(host);
    expect(sanitized.candidates).toEqual([{ candidate: relay }]);
  });
});

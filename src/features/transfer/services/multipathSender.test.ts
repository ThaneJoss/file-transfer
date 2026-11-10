import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateCloudflareTurnIceServers } from "../../turn/services/cloudflareTurn";
import {
  decodeTransferAnswer,
  encodeTransferOffer,
  fileTransferAnswerKind,
} from "../protocol/fileProtocol";
import type { MultipathTransferOffer } from "../protocol/fileProtocol";
import { sha256Blob } from "../protocol/fileStream";
import { prepareSfuSender } from "../transports/sfu";
import { createWebRtcSenderSession } from "../transports/webrtc";
import type { WebRtcSenderSession, WebRtcSignal } from "../transports/webrtc";
import { probeChannel, sendFileOnChannel } from "./channelTransfer";
import { winnerRecoveryTimeoutMs } from "./multipathCoordinator";
import type { RouteStates } from "./multipathCoordinator";
import { runMultipathSender } from "./multipathSender";
import {
  pollPickupAnswer,
  pollPickupWinner,
  publishPickupOffer,
  reservePickup,
  setPickupSelection,
} from "./pickupApi";
import { prepareR2Route } from "./r2Transfer";
import { reportVerifiedTransferUsage } from "./transferUsage";

vi.mock("../../turn/services/cloudflareTurn", () => ({
  generateCloudflareTurnIceServers: vi.fn(),
}));
vi.mock("../protocol/fileProtocol", async (importOriginal) => ({
  ...await importOriginal<typeof import("../protocol/fileProtocol")>(),
  encodeTransferOffer: vi.fn(),
  decodeTransferAnswer: vi.fn(),
}));
vi.mock("../protocol/fileStream", async (importOriginal) => ({
  ...await importOriginal<typeof import("../protocol/fileStream")>(),
  sha256Blob: vi.fn(),
}));
vi.mock("../transports/sfu", () => ({ prepareSfuSender: vi.fn() }));
vi.mock("../transports/webrtc", () => ({ createWebRtcSenderSession: vi.fn() }));
vi.mock("./channelTransfer", async (importOriginal) => ({
  // Keep estimateCompletionMs so the coordinator uses the real route ranking.
  ...await importOriginal<typeof import("./channelTransfer")>(),
  probeChannel: vi.fn(),
  sendFileOnChannel: vi.fn(),
}));
vi.mock("./pickupApi", () => ({
  pollPickupAnswer: vi.fn(),
  pollPickupWinner: vi.fn(),
  publishPickupOffer: vi.fn(),
  reservePickup: vi.fn(),
  setPickupSelection: vi.fn(),
  setPickupWinner: vi.fn(),
}));
vi.mock("./r2Transfer", () => ({
  prepareR2Route: vi.fn(),
  uploadR2File: vi.fn(),
}));
vi.mock("./transferUsage", () => ({ reportVerifiedTransferUsage: vi.fn() }));

const digest = "ab".repeat(32);
const usableMethods = ["direct", "stun"] as const;
type UsableMethod = (typeof usableMethods)[number];

let events: string[];
let snapshots: RouteStates[];
let publishedOffer: MultipathTransferOffer | undefined;
let sessions: Record<UsableMethod, WebRtcSenderSession>;
let pickup: { code: string; expiresAt: number };
let file: File;

function signalFor(route: UsableMethod, role: "offer" | "answer"): WebRtcSignal {
  return {
    kind: "file-transfer-webrtc-signal",
    version: 1,
    route,
    role,
    description: { type: role, sdp: "v=0\r\n" },
    candidates: [],
    createdAt: Date.now(),
  };
}

function createSession(route: UsableMethod): WebRtcSenderSession {
  const channel = { readyState: "open" } as RTCDataChannel;
  return {
    route,
    peer: {} as RTCPeerConnection,
    channel,
    prepareOffer: vi.fn(async () => signalFor(route, "offer")),
    applyAnswer: vi.fn(async () => undefined),
    waitForDataChannel: vi.fn(async () => channel),
    dispose: vi.fn(() => { events.push(`dispose:${route}`); }),
  };
}

function currentOffer() {
  if (!publishedOffer) throw new Error("The sender has not published an offer.");
  return publishedOffer;
}

function startSender(signal: AbortSignal) {
  return runMultipathSender({
    file,
    mode: "auto",
    signal,
    callbacks: { onRoutes: (routes) => { snapshots.push(routes); } },
  });
}

describe("automatic sender recovery after a channel acknowledgement timeout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    events = [];
    snapshots = [];
    publishedOffer = undefined;
    file = new File(["test payload"], "test.bin", { type: "application/octet-stream" });
    pickup = { code: "12345678", expiresAt: Date.now() + 60_000 };
    sessions = { direct: createSession("direct"), stun: createSession("stun") };

    vi.mocked(reservePickup).mockResolvedValue(pickup);
    vi.mocked(sha256Blob).mockResolvedValue(digest);
    vi.mocked(generateCloudflareTurnIceServers).mockRejectedValue(new Error("TURN unavailable"));
    vi.mocked(prepareSfuSender).mockRejectedValue(new Error("SFU unavailable"));
    vi.mocked(prepareR2Route).mockRejectedValue(new Error("R2 unavailable"));
    vi.mocked(createWebRtcSenderSession).mockImplementation(({ route }) => {
      if (route === "turn") throw new Error("TURN is not prepared in this test.");
      return sessions[route];
    });
    vi.mocked(encodeTransferOffer).mockImplementation(async (offer) => {
      publishedOffer = offer;
      return "encoded-offer";
    });
    vi.mocked(publishPickupOffer).mockResolvedValue({ accepted: true });
    vi.mocked(pollPickupAnswer).mockResolvedValue("encoded-answer");
    vi.mocked(decodeTransferAnswer).mockImplementation(async () => ({
      kind: fileTransferAnswerKind,
      transferId: currentOffer().transferId,
      routes: usableMethods.map((route) => ({ kind: route, signal: signalFor(route, "answer") })),
      metrics: {},
    }));
    vi.mocked(probeChannel).mockImplementation(async (route) => ({
      method: route.method,
      bytes: 48 * 1024,
      elapsedMs: route.method === "direct" ? 10 : 20,
      bytesPerSecond: route.method === "direct" ? 2_000_000 : 1_000_000,
    }));
    vi.mocked(setPickupSelection).mockImplementation(async (_code, route) => {
      events.push(`selection:${route}`);
      return { accepted: true as const };
    });
    vi.mocked(sendFileOnChannel).mockImplementation(async ({ route, offer }) => {
      events.push(`send:${route.method}`);
      if (route.method === "direct") {
        throw new DOMException("等待分块确认超时。", "TimeoutError");
      }
      return {
        kind: "transfer-complete" as const,
        transferId: offer.transferId,
        route: route.method,
        bytes: offer.file.size,
        sha256: offer.file.sha256,
      };
    });
    vi.mocked(pollPickupWinner).mockImplementation(async () => {
      events.push("winner:recovery");
      // A recovery deadline is an ordinary failure, not a remote cancellation.
      throw new Error("Winner recovery deadline expired.");
    });
    vi.mocked(reportVerifiedTransferUsage).mockResolvedValue(true);
  });

  it("checks for a verified winner before falling back to the next route", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = await startSender(controller.signal);

    expect(events.slice(0, 6)).toEqual([
      "selection:direct",
      "send:direct",
      "winner:recovery",
      "dispose:direct",
      "selection:stun",
      "send:stun",
    ]);
    expect(vi.mocked(sendFileOnChannel).mock.calls.map(([options]) => options.route.method))
      .toEqual(["direct", "stun"]);
    expect(pollPickupWinner).toHaveBeenCalledOnce();
    const recoveryCall = vi.mocked(pollPickupWinner).mock.calls[0];
    expect(recoveryCall?.[0]).toBe(pickup.code);
    expect(recoveryCall?.[1]).not.toBe(controller.signal);
    expect(recoveryCall?.[1].aborted).toBe(true);
    expect(recoveryCall?.[2]).toBeGreaterThanOrEqual(startedAt + winnerRecoveryTimeoutMs);
    expect(recoveryCall?.[2]).toBeLessThanOrEqual(Date.now() + winnerRecoveryTimeoutMs);
    expect(recoveryCall?.[2]).toBeLessThanOrEqual(pickup.expiresAt);
    expect(controller.signal.aborted).toBe(false);
    expect(snapshots.some((routes) => routes.direct === "failed")).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ direct: "failed", stun: "complete" });
    expect(result.winner).toEqual({ route: "stun", bytes: file.size, sha256: digest });
    expect(reportVerifiedTransferUsage).toHaveBeenCalledExactlyOnceWith({
      service: "stun",
      bytes: file.size,
      transferId: currentOffer().transferId,
    });
    expect(sessions.direct.dispose).toHaveBeenCalled();
    expect(sessions.stun.dispose).toHaveBeenCalled();
  });

  it("accepts a verified backend winner after the timeout without sending on the fallback", async () => {
    vi.mocked(pollPickupWinner).mockImplementation(async () => {
      events.push("winner:recovery");
      return { route: "direct" as const, bytes: file.size, sha256: digest };
    });
    const controller = new AbortController();
    const result = await startSender(controller.signal);

    expect(events.slice(0, 3)).toEqual([
      "selection:direct",
      "send:direct",
      "winner:recovery",
    ]);
    expect(sendFileOnChannel).toHaveBeenCalledOnce();
    expect(setPickupSelection).toHaveBeenCalledExactlyOnceWith(
      pickup.code,
      "direct",
      controller.signal,
    );
    expect(pollPickupWinner).toHaveBeenCalledOnce();
    expect(vi.mocked(pollPickupWinner).mock.calls[0]?.[1].aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(snapshots.some((routes) => routes.direct === "failed")).toBe(false);
    expect(snapshots.at(-1)).toMatchObject({ direct: "complete" });
    expect(result.winner).toEqual({ route: "direct", bytes: file.size, sha256: digest });
    expect(reportVerifiedTransferUsage).toHaveBeenCalledExactlyOnceWith({
      service: "direct",
      bytes: file.size,
      transferId: currentOffer().transferId,
    });
    expect(sessions.direct.dispose).toHaveBeenCalled();
    expect(sessions.stun.dispose).toHaveBeenCalled();
  });
});

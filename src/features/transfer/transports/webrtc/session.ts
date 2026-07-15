import { abortReason, throwIfAborted, waitWithAbort } from "./abort";
import {
  createWebRtcSignal,
  sanitizeRemoteSignal,
} from "./candidates";
import { waitForDataChannelOpen } from "./dataChannel";
import type {
  WebRtcReceiverSession,
  WebRtcRoute,
  WebRtcSenderSession,
  WebRtcSessionOptions,
  WebRtcSignal,
  WebRtcWaitOptions,
} from "./types";

const defaultStunServer: RTCIceServer = { urls: "stun:stun.cloudflare.com:3478" };
const defaultIceGatheringTimeoutMs = 30_000;
const defaultTurnIceGatheringTimeoutMs = 90_000;
const defaultChannelOpenTimeoutMs = 20_000;
const defaultTurnChannelOpenTimeoutMs = 90_000;

type IceCandidateCollection = {
  candidates: RTCIceCandidateInit[];
  errors: string[];
  stop(): void;
};

function routeName(route: WebRtcRoute) {
  return route === "direct" ? "Direct" : route.toUpperCase();
}

export function createWebRtcConfiguration(route: WebRtcRoute, iceServers?: RTCIceServer[]): RTCConfiguration {
  if (route === "direct") return { iceServers: [] };
  if (route === "stun") return { iceServers: iceServers?.length ? iceServers : [defaultStunServer] };
  if (!iceServers?.length) throw new Error("TURN 路径缺少临时 iceServers。请先获取 TURN 凭据。");
  return { iceServers, iceTransportPolicy: "relay" };
}

function formatIceCandidateError(event: RTCPeerConnectionIceErrorEvent) {
  const url = event.url ? `${event.url} ` : "";
  return `${url}${event.errorCode}${event.errorText ? ` ${event.errorText}` : ""}`;
}

function collectIceCandidates(peer: RTCPeerConnection): IceCandidateCollection {
  const candidates: RTCIceCandidateInit[] = [];
  const errors: string[] = [];
  const onCandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) candidates.push(event.candidate.toJSON());
  };
  const onCandidateError = (event: RTCPeerConnectionIceErrorEvent) => {
    errors.push(formatIceCandidateError(event));
  };
  peer.addEventListener("icecandidate", onCandidate);
  peer.addEventListener("icecandidateerror", onCandidateError);

  return {
    candidates,
    errors,
    stop() {
      peer.removeEventListener("icecandidate", onCandidate);
      peer.removeEventListener("icecandidateerror", onCandidateError);
    },
  };
}

function waitForIceGathering(
  peer: RTCPeerConnection,
  collection: IceCandidateCollection,
  { route, timeoutMs, signal }: { route: WebRtcRoute; timeoutMs: number; signal?: AbortSignal },
) {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (peer.iceGatheringState === "complete") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    const onAbort = () => done(abortReason(signal!));
    const timer = globalThis.setTimeout(() => {
      const errorSuffix = collection.errors.length
        ? ` 最近的 ICE 错误：${collection.errors.slice(-3).join("；")}`
        : "";
      done(new Error(`${routeName(route)} ICE candidate 收集超时。${errorSuffix}`));
    }, timeoutMs);

    peer.addEventListener("icegatheringstatechange", onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function addRemoteCandidates(
  peer: RTCPeerConnection,
  signalPayload: WebRtcSignal,
  operationSignal?: AbortSignal,
) {
  const embeddedCandidates = new Set(
    (signalPayload.description.sdp?.match(/^a=candidate:.*$/gm) ?? []).map((line) => line.slice(2)),
  );
  for (const candidate of signalPayload.candidates) {
    throwIfAborted(operationSignal);
    if (!candidate.candidate || embeddedCandidates.has(candidate.candidate)) continue;
    await waitWithAbort(peer.addIceCandidate(candidate), operationSignal);
  }
  throwIfAborted(operationSignal);
  await waitWithAbort(peer.addIceCandidate(null), operationSignal);
}

function assertSessionActive(peer: RTCPeerConnection, disposed: boolean) {
  if (disposed || peer.connectionState === "closed") throw new Error("WebRTC 会话已经关闭。");
}

function createPeer(options: WebRtcSessionOptions) {
  const configuration = createWebRtcConfiguration(options.route, options.iceServers);
  return options.peerConnectionFactory
    ? options.peerConnectionFactory(configuration)
    : new RTCPeerConnection(configuration);
}

function iceTimeout(options: WebRtcSessionOptions, override?: number) {
  return override ?? options.iceGatheringTimeoutMs ??
    (options.route === "turn" ? defaultTurnIceGatheringTimeoutMs : defaultIceGatheringTimeoutMs);
}

function channelTimeout(options: WebRtcSessionOptions, override?: number) {
  return override ?? options.channelOpenTimeoutMs ??
    (options.route === "turn" ? defaultTurnChannelOpenTimeoutMs : defaultChannelOpenTimeoutMs);
}

export function createWebRtcSenderSession(options: WebRtcSessionOptions): WebRtcSenderSession {
  const peer = createPeer(options);
  const channel = peer.createDataChannel(options.dataChannelLabel ?? `file-transfer-${options.route}`, {
    ordered: true,
  });
  channel.binaryType = "arraybuffer";
  let disposed = false;
  let offerPrepared = false;
  let answerApplied = false;

  return {
    route: options.route,
    peer,
    channel,
    async prepareOffer(waitOptions = {}) {
      assertSessionActive(peer, disposed);
      throwIfAborted(waitOptions.signal);
      if (offerPrepared) throw new Error(`${routeName(options.route)} Offer 已经生成。`);
      offerPrepared = true;
      const collection = collectIceCandidates(peer);
      try {
        const offer = await waitWithAbort(peer.createOffer(), waitOptions.signal);
        await waitWithAbort(peer.setLocalDescription(offer), waitOptions.signal);
        await waitForIceGathering(peer, collection, {
          route: options.route,
          timeoutMs: iceTimeout(options, waitOptions.timeoutMs),
          signal: waitOptions.signal,
        });
        throwIfAborted(waitOptions.signal);
        if (!peer.localDescription) throw new Error(`${routeName(options.route)} 浏览器没有生成 Offer。`);
        return createWebRtcSignal(options.route, "offer", peer.localDescription, collection.candidates);
      } finally {
        collection.stop();
      }
    },
    async applyAnswer(answer, applyOptions = {}) {
      assertSessionActive(peer, disposed);
      throwIfAborted(applyOptions.signal);
      if (!offerPrepared) throw new Error(`请先生成 ${routeName(options.route)} Offer。`);
      if (answerApplied) throw new Error(`${routeName(options.route)} Answer 已经应用。`);
      const sanitized = sanitizeRemoteSignal(answer, options.route, "answer");
      answerApplied = true;
      await waitWithAbort(peer.setRemoteDescription(sanitized.description), applyOptions.signal);
      await addRemoteCandidates(peer, sanitized, applyOptions.signal);
    },
    async waitForDataChannel(waitOptions = {}) {
      assertSessionActive(peer, disposed);
      await waitForDataChannelOpen(channel, peer, {
        timeoutMs: channelTimeout(options, waitOptions.timeoutMs),
        signal: waitOptions.signal,
        onStatus: waitOptions.onStatus,
      });
      return channel;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (channel.readyState !== "closed") channel.close();
      peer.close();
    },
  };
}

function waitForIncomingDataChannel(
  peer: RTCPeerConnection,
  { timeoutMs, signal, onStatus }: Required<Pick<WebRtcWaitOptions, "timeoutMs">> & WebRtcWaitOptions,
) {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<RTCDataChannel>((resolve, reject) => {
    let finished = false;
    const done = (channel?: RTCDataChannel, error?: Error) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      peer.removeEventListener("datachannel", onDataChannel);
      peer.removeEventListener("connectionstatechange", onConnectionState);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(channel!);
    };
    const onDataChannel = (event: RTCDataChannelEvent) => done(event.channel);
    const onConnectionState = () => {
      onStatus?.(`等待对端 DataChannel：peer=${peer.connectionState}，ice=${peer.iceConnectionState}`);
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        done(undefined, new Error(`PeerConnection 连接失败：${peer.connectionState}。`));
      }
    };
    const onAbort = () => done(undefined, abortReason(signal!));
    const timer = globalThis.setTimeout(
      () => done(undefined, new Error("等待对端 DataChannel 超时。")),
      timeoutMs,
    );

    peer.addEventListener("datachannel", onDataChannel);
    peer.addEventListener("connectionstatechange", onConnectionState);
    signal?.addEventListener("abort", onAbort, { once: true });
    onStatus?.(`等待对端 DataChannel：peer=${peer.connectionState}，ice=${peer.iceConnectionState}`);
  });
}

export function createWebRtcReceiverSession(options: WebRtcSessionOptions): WebRtcReceiverSession {
  const peer = createPeer(options);
  let channel: RTCDataChannel | null = null;
  let disposed = false;
  let offerAccepted = false;
  const captureChannel = (event: RTCDataChannelEvent) => {
    if (channel) {
      event.channel.close();
      return;
    }
    channel = event.channel;
    channel.binaryType = "arraybuffer";
  };
  peer.addEventListener("datachannel", captureChannel);

  return {
    route: options.route,
    peer,
    get channel() {
      return channel;
    },
    async acceptOffer(offer, waitOptions = {}) {
      assertSessionActive(peer, disposed);
      throwIfAborted(waitOptions.signal);
      if (offerAccepted) throw new Error(`${routeName(options.route)} Offer 已经处理。`);
      const sanitized = sanitizeRemoteSignal(offer, options.route, "offer");
      offerAccepted = true;
      await waitWithAbort(peer.setRemoteDescription(sanitized.description), waitOptions.signal);
      await addRemoteCandidates(peer, sanitized, waitOptions.signal);

      const collection = collectIceCandidates(peer);
      try {
        throwIfAborted(waitOptions.signal);
        const answer = await waitWithAbort(peer.createAnswer(), waitOptions.signal);
        await waitWithAbort(peer.setLocalDescription(answer), waitOptions.signal);
        await waitForIceGathering(peer, collection, {
          route: options.route,
          timeoutMs: iceTimeout(options, waitOptions.timeoutMs),
          signal: waitOptions.signal,
        });
        throwIfAborted(waitOptions.signal);
        if (!peer.localDescription) throw new Error(`${routeName(options.route)} 浏览器没有生成 Answer。`);
        return createWebRtcSignal(options.route, "answer", peer.localDescription, collection.candidates);
      } finally {
        collection.stop();
      }
    },
    async waitForDataChannel(waitOptions = {}) {
      assertSessionActive(peer, disposed);
      const timeoutMs = channelTimeout(options, waitOptions.timeoutMs);
      const startedAt = Date.now();
      const currentChannel = channel ?? await waitForIncomingDataChannel(peer, {
        ...waitOptions,
        timeoutMs,
      });
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      await waitForDataChannelOpen(currentChannel, peer, {
        timeoutMs: remainingMs,
        signal: waitOptions.signal,
        onStatus: waitOptions.onStatus,
      });
      return currentChannel;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      peer.removeEventListener("datachannel", captureChannel);
      if (channel?.readyState !== "closed") channel?.close();
      peer.close();
    },
  };
}

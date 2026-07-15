import { abortReason, throwIfAborted } from "./abort";

export type DataChannelOpenOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
};

export function waitForDataChannelOpen(
  channel: RTCDataChannel,
  peer: RTCPeerConnection,
  { timeoutMs, signal, onStatus }: DataChannelOpenOptions,
) {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (channel.readyState === "open") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const peerState = () =>
      `peer=${peer.connectionState}，ice=${peer.iceConnectionState}，gathering=${peer.iceGatheringState}，channel=${channel.readyState}`;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      peer.removeEventListener("iceconnectionstatechange", onIceState);
      peer.removeEventListener("connectionstatechange", onPeerState);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => done();
    const onClose = () => done(new Error("DataChannel 已关闭，连接没有建立。"));
    const onError = () => done(new Error("DataChannel 发生错误，连接没有建立。"));
    const reportStatus = () => onStatus?.(`等待 DataChannel 打开：${peerState()}`);
    const onIceState = () => {
      reportStatus();
      if (peer.iceConnectionState === "failed" || peer.iceConnectionState === "closed") {
        done(new Error(`ICE 连接失败：${peer.iceConnectionState}。`));
      }
    };
    const onPeerState = () => {
      reportStatus();
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        done(new Error(`PeerConnection 连接失败：${peer.connectionState}。`));
      }
    };
    const onAbort = () => done(abortReason(signal!));
    const timer = globalThis.setTimeout(() => {
      done(new Error(`DataChannel 打开超时。当前状态：${peerState()}。`));
    }, timeoutMs);

    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    peer.addEventListener("iceconnectionstatechange", onIceState);
    peer.addEventListener("connectionstatechange", onPeerState);
    signal?.addEventListener("abort", onAbort, { once: true });
    reportStatus();
  });
}

export function waitForBuffer(
  channel: RTCDataChannel,
  {
    highWaterMark,
    lowWaterMark,
    signal,
    onWait,
  }: {
    highWaterMark: number;
    lowWaterMark: number;
    signal?: AbortSignal;
    onWait?: () => void;
  },
) {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (lowWaterMark < 0 || highWaterMark < lowWaterMark) {
    return Promise.reject(new Error("DataChannel 背压阈值无效。"));
  }
  if (channel.readyState !== "open") return Promise.reject(new Error("DataChannel 已关闭，发送已中断。"));
  if (channel.bufferedAmount <= highWaterMark) return Promise.resolve();

  onWait?.();
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const previousThreshold = channel.bufferedAmountLowThreshold;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      channel.bufferedAmountLowThreshold = previousThreshold;
      if (error) reject(error);
      else resolve();
    };
    const onLow = () => {
      if (channel.bufferedAmount <= lowWaterMark) done();
    };
    const onClose = () => done(new Error("DataChannel 已关闭，发送已中断。"));
    const onError = () => done(new Error("DataChannel 发生错误，发送已中断。"));
    const onAbort = () => done(abortReason(signal!));

    channel.bufferedAmountLowThreshold = lowWaterMark;
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    onLow();
  });
}

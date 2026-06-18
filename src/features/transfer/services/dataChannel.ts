export type DataChannelOpenOptions = {
  timeoutMs: number;
  includeIceState?: boolean;
  onStatus?: (message: string) => void;
};

export function waitForDataChannelOpen(
  channel: RTCDataChannel,
  peer: RTCPeerConnection,
  { timeoutMs, includeIceState = false, onStatus }: DataChannelOpenOptions,
) {
  if (channel.readyState === "open") return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const done = (error?: Error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      peer.removeEventListener("iceconnectionstatechange", onIceState);
      peer.removeEventListener("connectionstatechange", onPeerState);
      if (error) reject(error);
      else resolve();
    };
    const peerStateText = () =>
      includeIceState
        ? `peer=${peer.connectionState}，ice=${peer.iceConnectionState}，gathering=${peer.iceGatheringState}，channel=${channel.readyState}`
        : `peer=${peer.connectionState}，channel=${channel.readyState}`;
    const onOpen = () => done();
    const onClose = () => done(new Error("DataChannel 已关闭，连接没有建立。"));
    const onError = () => done(new Error("DataChannel 发生错误，连接没有建立。"));
    const reportStatus = () => onStatus?.(`等待 DataChannel 打开：${peerStateText()}`);
    const onIceState = () => {
      reportStatus();
      if (peer.iceConnectionState === "failed" || peer.iceConnectionState === "closed") {
        done(new Error(`ICE 连接失败：${peer.iceConnectionState}。请确认发送方粘贴的是这次生成的 Answer。`));
      }
    };
    const onPeerState = () => {
      reportStatus();
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        done(new Error(`PeerConnection 连接失败：${peer.connectionState}。请重新生成并交换同一轮 Offer/Answer。`));
      }
    };
    const timer = window.setTimeout(() => {
      done(
        new Error(
          `DataChannel 没有打开。当前状态：${peerStateText()}。请重新生成并交换同一轮完整 Offer/Answer。`,
        ),
      );
    }, timeoutMs);
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    peer.addEventListener("iceconnectionstatechange", onIceState);
    peer.addEventListener("connectionstatechange", onPeerState);
    reportStatus();
  });
}

export function waitForBuffer(
  channel: RTCDataChannel,
  {
    highWaterMark,
    lowWaterMark,
    onWait,
  }: {
    highWaterMark: number;
    lowWaterMark: number;
    onWait?: () => void;
  },
) {
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
      channel.bufferedAmountLowThreshold = previousThreshold;
      if (error) reject(error);
      else resolve();
    };
    const onLow = () => {
      if (channel.bufferedAmount <= lowWaterMark) done();
    };
    const onClose = () => done(new Error("DataChannel 已关闭，发送已中断。"));
    const onError = () => done(new Error("DataChannel 发生错误，发送已中断。"));

    channel.bufferedAmountLowThreshold = lowWaterMark;
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    onLow();
  });
}

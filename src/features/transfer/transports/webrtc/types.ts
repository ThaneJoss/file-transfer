export type WebRtcRoute = "direct" | "stun" | "turn";

export type WebRtcSignalRole = "offer" | "answer";

export type WebRtcSignal = {
  kind: "file-transfer-webrtc-signal";
  version: 1;
  route: WebRtcRoute;
  role: WebRtcSignalRole;
  description: RTCSessionDescriptionInit;
  candidates: RTCIceCandidateInit[];
  createdAt: number;
};

export type WebRtcWaitOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
};

export type WebRtcSessionOptions = {
  route: WebRtcRoute;
  iceServers?: RTCIceServer[];
  dataChannelLabel?: string;
  iceGatheringTimeoutMs?: number;
  channelOpenTimeoutMs?: number;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
};

export type WebRtcSenderSession = {
  readonly route: WebRtcRoute;
  readonly peer: RTCPeerConnection;
  readonly channel: RTCDataChannel;
  prepareOffer(options?: WebRtcWaitOptions): Promise<WebRtcSignal>;
  applyAnswer(answer: WebRtcSignal, options?: Pick<WebRtcWaitOptions, "signal">): Promise<void>;
  waitForDataChannel(options?: WebRtcWaitOptions): Promise<RTCDataChannel>;
  dispose(): void;
};

export type WebRtcReceiverSession = {
  readonly route: WebRtcRoute;
  readonly peer: RTCPeerConnection;
  readonly channel: RTCDataChannel | null;
  acceptOffer(offer: WebRtcSignal, options?: WebRtcWaitOptions): Promise<WebRtcSignal>;
  waitForDataChannel(options?: WebRtcWaitOptions): Promise<RTCDataChannel>;
  dispose(): void;
};

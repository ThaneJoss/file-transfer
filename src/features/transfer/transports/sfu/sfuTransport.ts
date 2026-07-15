import {
  createCallsSession,
  createPublisherChannel,
  createSubscriberChannel,
  establishDataChannelTransport,
} from "../../../sfu/services/callsApi";
import type { AsyncControl, CallsSession } from "../../../sfu/services/callsApi";

export const sfuSenderDescriptorKind = "cloudflare-calls-datachannel-duplex-v2" as const;
export const sfuReceiverDescriptorKind = "cloudflare-calls-datachannel-duplex-answer-v2" as const;

export type SfuSenderDescriptor = {
  kind: typeof sfuSenderDescriptorKind;
  publisherSessionId: string;
  dataChannelName: string;
};

/**
 * The receiver publishes a second, reverse DataChannel in the same Calls
 * session that subscribes to the sender's forward channel. The sender must
 * consume this descriptor with `acceptAnswer` before the transport is duplex.
 */
export type SfuReceiverDescriptor = {
  kind: typeof sfuReceiverDescriptorKind;
  publisherSessionId: string;
  dataChannelName: string;
};

export type SfuTransportOptions = AsyncControl & {
  dataChannelName?: string;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
};

export type SfuTransportSession = {
  sessionId: string;
  peerConnection: RTCPeerConnection;
  /**
   * An RTCDataChannel-compatible duplex facade. Its outbound side is a local
   * publisher and its inbound side is a gated remote subscriber.
   */
  channel: RTCDataChannel;
  ready: Promise<RTCDataChannel>;
  dispose: () => void;
};

export type SfuSenderSession = SfuTransportSession & {
  role: "sender";
  descriptor: SfuSenderDescriptor;
  acceptAnswer: (
    descriptor: SfuReceiverDescriptor,
    control?: AsyncControl,
  ) => Promise<RTCDataChannel>;
};

export type SfuReceiverSession = SfuTransportSession & {
  role: "receiver";
  answerDescriptor: SfuReceiverDescriptor;
};

const defaultOpenTimeoutMs = 30_000;
const keepaliveIntervalMs = 10_000;
const subscriberAckFrame = "ack";
const internalKeepaliveFrame = "\u0000file-transfer:sfu:keepalive:v1";
const peerConfiguration: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  bundlePolicy: "max-bundle",
};

export async function prepareSfuSender(
  options: SfuTransportOptions = {},
): Promise<SfuSenderSession> {
  const peer = createPeer(options.peerConnectionFactory);
  let outbound: RTCDataChannel | null = null;
  let duplex: SfuDuplexDataChannel | null = null;

  try {
    const session = await createCallsSession(peer, options);
    await establishDataChannelTransport(session, options);
    const dataChannelName = options.dataChannelName ?? createDataChannelName("forward");
    outbound = await createPublisherChannel(session, dataChannelName, options);
    outbound.binaryType = "arraybuffer";
    duplex = new SfuDuplexDataChannel(outbound, peer);

    // A pickup code can wait much longer than Cloudflare's inactivity window.
    // Confirm the forward publisher is open now; the facade remains connecting
    // until the receiver's reverse descriptor is accepted later.
    await waitForSfuDataChannelOpen(outbound, peer, options);
    duplex.startPublisherKeepalive();

    const lifecycle = createSessionLifecycle(session, duplex, options);
    let answerAccepted = false;
    const acceptAnswer = async (
      descriptor: SfuReceiverDescriptor,
      control: AsyncControl = {},
    ) => {
      if (answerAccepted) throw new Error("SFU reverse 通道应答已处理。 ");
      validateReceiverDescriptor(descriptor);
      answerAccepted = true;
      try {
        const inbound = await createSubscriberChannel(
          session,
          descriptor.publisherSessionId,
          descriptor.dataChannelName,
          mergeControl(options.signal, control),
        );
        await duplex!.activateInbound(inbound, mergeControl(options.signal, control));
        return duplex!.asRtcDataChannel();
      } catch (error) {
        lifecycle.dispose();
        throw contextualError("订阅 SFU reverse DataChannel 失败", error);
      }
    };

    return {
      role: "sender",
      sessionId: session.id,
      peerConnection: peer,
      channel: duplex.asRtcDataChannel(),
      descriptor: {
        kind: sfuSenderDescriptorKind,
        publisherSessionId: session.id,
        dataChannelName,
      },
      acceptAnswer,
      ...lifecycle,
    };
  } catch (error) {
    duplex?.abort(error);
    closeLocalTransport(outbound, peer);
    throw contextualError("创建 SFU forward 发布通道失败", error);
  }
}

export async function prepareSfuReceiver(
  descriptor: SfuSenderDescriptor,
  options: SfuTransportOptions = {},
): Promise<SfuReceiverSession> {
  validateSenderDescriptor(descriptor);
  const peer = createPeer(options.peerConnectionFactory);
  let inbound: RTCDataChannel | null = null;
  let outbound: RTCDataChannel | null = null;
  let duplex: SfuDuplexDataChannel | null = null;

  try {
    const session = await createCallsSession(peer, options);
    await establishDataChannelTransport(session, options);
    const reverseDataChannelName = options.dataChannelName ?? createDataChannelName("reverse");

    // Start both API operations together to leave the gated remote channel as
    // much of its 15-second acknowledgement window as possible.
    [inbound, outbound] = await Promise.all([
      createSubscriberChannel(
        session,
        descriptor.publisherSessionId,
        descriptor.dataChannelName,
        options,
      ),
      createPublisherChannel(session, reverseDataChannelName, options),
    ]);
    inbound.binaryType = "arraybuffer";
    outbound.binaryType = "arraybuffer";
    duplex = new SfuDuplexDataChannel(outbound, peer);
    duplex.startPublisherKeepalive();
    const lifecycle = createSessionLifecycle(session, duplex, options);
    await duplex.activateInbound(inbound, options);

    const answerDescriptor: SfuReceiverDescriptor = {
      kind: sfuReceiverDescriptorKind,
      publisherSessionId: session.id,
      dataChannelName: reverseDataChannelName,
    };
    return {
      role: "receiver",
      sessionId: session.id,
      peerConnection: peer,
      channel: duplex.asRtcDataChannel(),
      answerDescriptor,
      ...lifecycle,
    };
  } catch (error) {
    duplex?.abort(error);
    closeChannels([inbound, outbound]);
    closePeer(peer);
    throw contextualError("创建 SFU 双向接收通道失败", error);
  }
}

export function waitForSfuDataChannelOpen(
  channel: RTCDataChannel,
  peerConnection: RTCPeerConnection,
  control: AsyncControl = {},
): Promise<RTCDataChannel> {
  if (channel.readyState === "open") return Promise.resolve(channel);
  if (channel.readyState === "closing" || channel.readyState === "closed") {
    return Promise.reject(new Error("SFU DataChannel 已关闭，无法开始传输。"));
  }

  const timeoutMs = normalizeTimeout(control.timeoutMs, defaultOpenTimeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onOpen = () => finish(() => resolve(channel));
    const onClose = () => finish(() => reject(new Error("SFU DataChannel 在就绪前已关闭。")));
    const onError = () => finish(() => reject(new Error("SFU DataChannel 建立失败。")));
    const onPeerState = () => {
      if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
        finish(() => reject(new Error(`SFU PeerConnection 状态异常：${peerConnection.connectionState}。`)));
      }
    };
    const onAbort = () => {
      finish(() => reject(createAbortError("等待 SFU DataChannel 时操作已取消。", control.signal?.reason)));
    };
    const timer = globalThis.setTimeout(() => {
      finish(() => reject(new Error(`等待 SFU DataChannel 超时（${timeoutMs}ms）。`)));
    }, timeoutMs);

    const cleanup = () => {
      globalThis.clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      peerConnection.removeEventListener("connectionstatechange", onPeerState);
      control.signal?.removeEventListener("abort", onAbort);
    };

    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
    peerConnection.addEventListener("connectionstatechange", onPeerState);
    if (control.signal?.aborted) onAbort();
    else control.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isSfuSenderDescriptor(value: unknown): value is SfuSenderDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<SfuSenderDescriptor>;
  return descriptor.kind === sfuSenderDescriptorKind && isPublisherDescriptor(descriptor);
}

export function isSfuReceiverDescriptor(value: unknown): value is SfuReceiverDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<SfuReceiverDescriptor>;
  return descriptor.kind === sfuReceiverDescriptorKind && isPublisherDescriptor(descriptor);
}

class SfuDuplexDataChannel extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  onbufferedamountlow: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onclosing: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onerror: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;
  onmessage: ((this: RTCDataChannel, ev: MessageEvent) => unknown) | null = null;
  onopen: ((this: RTCDataChannel, ev: Event) => unknown) | null = null;

  private inbound: RTCDataChannel | null = null;
  private state: RTCDataChannelState = "connecting";
  private settled = false;
  private resolveReady!: (channel: RTCDataChannel) => void;
  private rejectReady!: (error: unknown) => void;
  private readonly readyPromise: Promise<RTCDataChannel>;
  private readonly listenerCleanups: Array<() => void> = [];
  private stopKeepalive: (() => void) | null = null;

  constructor(
    private readonly outbound: RTCDataChannel,
    private readonly peerConnection: RTCPeerConnection,
  ) {
    super();
    this.readyPromise = new Promise<RTCDataChannel>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A session can be cancelled while its descriptor is waiting in a pickup.
    // Mark the promise handled without changing what callers observe on await.
    void this.readyPromise.catch(() => undefined);
    this.bindOutboundEvents();
  }

  get bufferedAmount() { return this.outbound.bufferedAmount; }
  get bufferedAmountLowThreshold() { return this.outbound.bufferedAmountLowThreshold; }
  set bufferedAmountLowThreshold(value: number) { this.outbound.bufferedAmountLowThreshold = value; }
  get id() { return this.outbound.id; }
  get label() { return this.outbound.label; }
  get maxPacketLifeTime() { return this.outbound.maxPacketLifeTime; }
  get maxRetransmits() { return this.outbound.maxRetransmits; }
  get negotiated() { return this.outbound.negotiated; }
  get ordered() { return this.outbound.ordered; }
  get protocol() { return this.outbound.protocol; }
  get readyState() { return this.state; }
  get ready() { return this.readyPromise; }

  asRtcDataChannel() {
    return this as unknown as RTCDataChannel;
  }

  startPublisherKeepalive() {
    if (this.stopKeepalive) return;
    let interval: ReturnType<typeof globalThis.setInterval> | undefined;
    const sendKeepalive = () => {
      if (this.outbound.readyState !== "open") return;
      try { this.outbound.send(internalKeepaliveFrame); } catch { /* close/error will retire the route */ }
    };
    const start = () => {
      if (interval !== undefined) return;
      sendKeepalive();
      interval = globalThis.setInterval(sendKeepalive, keepaliveIntervalMs);
    };
    if (this.outbound.readyState === "open") start();
    else this.outbound.addEventListener("open", start, { once: true });
    this.stopKeepalive = () => {
      this.outbound.removeEventListener("open", start);
      if (interval !== undefined) globalThis.clearInterval(interval);
      interval = undefined;
    };
  }

  async activateInbound(channel: RTCDataChannel, control: AsyncControl = {}) {
    if (this.inbound) throw new Error("SFU duplex inbound 通道已配置。");
    if (this.state !== "connecting") throw new Error("SFU duplex 通道已经关闭。");
    this.inbound = channel;
    channel.binaryType = this.binaryType;
    this.bindInboundEvents(channel);

    try {
      const inboundReady = waitForSfuDataChannelOpen(channel, this.peerConnection, control).then(() => {
        // Cloudflare consumes this first frame and only then opens the remote
        // subscriber gate. It must precede every application frame.
        channel.send(subscriberAckFrame);
      });
      await Promise.all([
        inboundReady,
        waitForSfuDataChannelOpen(this.outbound, this.peerConnection, control),
      ]);
      if (this.state !== "connecting") throw new Error("SFU duplex 通道在就绪前已关闭。");
      this.state = "open";
      this.settled = true;
      this.resolveReady(this.asRtcDataChannel());
      this.emit("open", new Event("open"));
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }

  send(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
    if (this.state !== "open") throw new DOMException("SFU duplex DataChannel 尚未就绪。", "InvalidStateError");
    if (typeof data === "string") this.outbound.send(data);
    else if (data instanceof Blob) this.outbound.send(data);
    else if (data instanceof ArrayBuffer) this.outbound.send(data);
    else this.outbound.send(data);
  }

  close() {
    this.closeWithError(new Error("SFU duplex DataChannel 已关闭。"));
  }

  abort(reason: unknown) {
    const error = reason instanceof Error || reason instanceof DOMException
      ? reason
      : new Error("SFU duplex DataChannel 已终止。");
    this.closeWithError(error);
  }

  private bindOutboundEvents() {
    this.listen(this.outbound, "bufferedamountlow", () => this.emit("bufferedamountlow", new Event("bufferedamountlow")));
    this.listen(this.outbound, "closing", () => this.beginClosing());
    this.listen(this.outbound, "close", () => this.closeWithError(new Error("SFU forward 发布通道已关闭。")));
    this.listen(this.outbound, "error", () => this.emit("error", new Event("error")));
  }

  private bindInboundEvents(channel: RTCDataChannel) {
    this.listen(channel, "message", (event) => {
      const message = event as MessageEvent;
      if (message.data === internalKeepaliveFrame) return;
      this.emit("message", new MessageEvent("message", {
        data: message.data,
        origin: message.origin,
        lastEventId: message.lastEventId,
        source: message.source,
        ports: [...message.ports],
      }));
    });
    this.listen(channel, "closing", () => this.beginClosing());
    this.listen(channel, "close", () => this.closeWithError(new Error("SFU remote 订阅通道已关闭。")));
    this.listen(channel, "error", () => this.emit("error", new Event("error")));
  }

  private listen(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    this.listenerCleanups.push(() => target.removeEventListener(type, listener));
  }

  private beginClosing() {
    if (this.state === "closing" || this.state === "closed") return;
    this.state = "closing";
    this.emit("closing", new Event("closing"));
  }

  private closeWithError(error: Error | DOMException) {
    if (this.state === "closed") return;
    this.beginClosing();
    this.stopKeepalive?.();
    this.stopKeepalive = null;
    for (const cleanup of this.listenerCleanups.splice(0)) cleanup();
    closeChannels([this.inbound, this.outbound]);
    this.state = "closed";
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(error);
    }
    this.emit("close", new Event("close"));
  }

  private emit(type: "bufferedamountlow" | "close" | "closing" | "error" | "message" | "open", event: Event) {
    this.dispatchEvent(event);
    const handler = this[`on${type}`] as ((this: RTCDataChannel, event: Event) => unknown) | null;
    handler?.call(this.asRtcDataChannel(), event);
  }
}

function createSessionLifecycle(
  session: CallsSession,
  channel: SfuDuplexDataChannel,
  options: SfuTransportOptions,
) {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", onAbort);
    channel.close();
    closePeer(session.peerConnection);
  };
  const onAbort = () => {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener("abort", onAbort);
    channel.abort(createAbortError("SFU DataChannel 操作已取消。", options.signal?.reason));
    closePeer(session.peerConnection);
  };

  channel.addEventListener("close", () => closePeer(session.peerConnection), { once: true });
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  return { ready: channel.ready, dispose };
}

function createPeer(factory: SfuTransportOptions["peerConnectionFactory"]) {
  const create = factory ?? ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  try {
    return create(peerConfiguration);
  } catch (error) {
    throw contextualError("浏览器无法创建 SFU PeerConnection", error);
  }
}

function closeLocalTransport(channel: RTCDataChannel | null, peer: RTCPeerConnection) {
  try {
    closeChannels([channel]);
  } finally {
    closePeer(peer);
  }
}

function closeChannels(channels: Array<RTCDataChannel | null>) {
  for (const channel of channels) {
    try {
      if (channel && channel.readyState !== "closed") channel.close();
    } catch { /* already closing */ }
  }
}

function closePeer(peer: RTCPeerConnection) {
  try {
    if (peer.connectionState !== "closed") peer.close();
  } catch { /* already closed */ }
}

function validateSenderDescriptor(descriptor: SfuSenderDescriptor) {
  if (!isSfuSenderDescriptor(descriptor)) throw new Error("SFU forward 发布通道描述格式不正确。");
}

function validateReceiverDescriptor(descriptor: SfuReceiverDescriptor) {
  if (!isSfuReceiverDescriptor(descriptor)) throw new Error("SFU reverse 发布通道描述格式不正确。");
}

function isPublisherDescriptor(value: { publisherSessionId?: unknown; dataChannelName?: unknown }) {
  return (
    typeof value.publisherSessionId === "string" &&
    value.publisherSessionId.trim().length > 0 &&
    typeof value.dataChannelName === "string" &&
    value.dataChannelName.trim().length > 0 &&
    value.dataChannelName.length <= 128
  );
}

function createDataChannelName(direction: "forward" | "reverse") {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${direction}-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function contextualError(context: string, error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}：${message}`, { cause: error });
}

function createAbortError(message: string, cause?: unknown) {
  const error = new DOMException(message, "AbortError");
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}

function normalizeTimeout(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("SFU 超时时间必须大于 0。");
  return Math.floor(value);
}

function mergeControl(parentSignal: AbortSignal | undefined, control: AsyncControl): AsyncControl {
  if (!parentSignal || parentSignal === control.signal) return control;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => controller.abort(signal.reason);
  if (parentSignal.aborted) abort(parentSignal);
  else if (control.signal?.aborted) abort(control.signal);
  else {
    parentSignal.addEventListener("abort", () => abort(parentSignal), { once: true });
    control.signal?.addEventListener("abort", () => abort(control.signal!), { once: true });
  }
  return { ...control, signal: controller.signal };
}

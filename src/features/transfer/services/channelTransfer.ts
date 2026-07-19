import { saveBlob } from "../../../lib/browser/download";
import { decryptTransferChunk, encryptTransferChunk } from "../crypto/fileEncryption";
import { throwIfAborted } from "../hooks/useTransferLifecycle";
import {
  decodeControlMessage,
  decodeFileFrame,
  encodeControlMessage,
  encodeFileFrame,
  messageDataToBuffer,
} from "../protocol/fileFrames";
import type { TransferControlMessage } from "../protocol/fileFrames";
import type { MultipathTransferOffer, TransferMethod } from "../protocol/fileProtocol";
import { createSha256Hasher, openReceiveSink } from "../protocol/fileStream";
import type { ReceiveSink, ReceiveTarget } from "../protocol/fileStream";

export type RealtimeMethod = Exclude<TransferMethod, "r2">;

export type RouteChannel = {
  method: RealtimeMethod;
  channel: RTCDataChannel;
  dispose: () => void | Promise<void>;
};

export type ProbeResult = {
  method: RealtimeMethod;
  bytes: number;
  elapsedMs: number;
  bytesPerSecond: number;
};

const probeBytes = 48 * 1024;

export async function probeChannel(route: RouteChannel, transferId: string, signal: AbortSignal): Promise<ProbeResult> {
  throwIfAborted(signal);
  await waitForChannelOpen(route.channel, signal);
  const probeId = randomUint32();
  const payload = new Uint8Array(probeBytes);
  crypto.getRandomValues(payload);
  const startedAt = performance.now();
  const waitController = linkedAbortController(signal);
  const acknowledged = waitForControl(
    route.channel,
    waitController.signal,
    (message): message is Extract<TransferControlMessage, { kind: "probe-ack" }> =>
      message.kind === "probe-ack" && message.transferId === transferId && message.probeId === probeId,
    5_000,
  );
  void acknowledged.catch(() => undefined);
  try {
    await sendWithBackpressure(route.channel, encodeFileFrame("probe", probeId, payload), signal);
    const message = await acknowledged;
    if (message.kind !== "probe-ack" || message.bytes !== payload.byteLength) throw new Error(`${route.method} 测速响应不完整。`);
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    return { method: route.method, bytes: payload.byteLength, elapsedMs, bytesPerSecond: payload.byteLength * 1000 / elapsedMs };
  } finally {
    waitController.abort(new DOMException("测速已结束。", "AbortError"));
  }
}

export function estimateCompletionMs(fileSize: number, result: Pick<ProbeResult, "bytesPerSecond" | "elapsedMs">) {
  return result.elapsedMs + (fileSize / Math.max(1, result.bytesPerSecond)) * 1000;
}

export async function sendFileOnChannel({
  route,
  offer,
  file,
  signal,
  onProgress,
  encryptionKey,
}: {
  route: RouteChannel;
  offer: MultipathTransferOffer;
  file: File;
  signal: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
  encryptionKey?: CryptoKey | null;
}) {
  throwIfAborted(signal);
  await waitForChannelOpen(route.channel, signal);
  const waitController = linkedAbortController(signal);
  type CompletionMessage = Extract<TransferControlMessage, { kind: "transfer-complete" | "transfer-error" }>;
  let earlyCompletion: CompletionMessage | null = null;
  const completion = waitForControl(route.channel, waitController.signal, (message): message is CompletionMessage =>
    (message.kind === "transfer-complete" || message.kind === "transfer-error") && message.transferId === offer.transferId,
  ).then((message) => { earlyCompletion = message; return message; });
  void completion.catch(() => undefined);
  const acknowledgements = createChunkAckTracker(route.channel, offer.transferId, waitController.signal);
  try {
    let sent = 0;
    onProgress?.(0, offer.file.size);
    for (let sequence = 0; sequence < offer.file.totalChunks; sequence += 1) {
      throwIfAborted(signal);
      if (earlyCompletion) break;
      await acknowledgements.waitForCredit(sequence);
      const start = sequence * offer.file.chunkSize;
      const chunk = new Uint8Array(await file.slice(start, Math.min(start + offer.file.chunkSize, offer.file.size)).arrayBuffer());
      const payload = offer.encryption
        ? await encryptTransferChunk(assertEncryptionKey(encryptionKey), offer.encryption, sequence, chunk)
        : chunk;
      await sendWithBackpressure(route.channel, encodeFileFrame("data", sequence, payload), signal);
      sent += chunk.byteLength;
      onProgress?.(sent, offer.file.size);
    }
    if (!earlyCompletion) {
      route.channel.send(encodeControlMessage({
        kind: "transfer-done",
        transferId: offer.transferId,
        totalChunks: offer.file.totalChunks,
        sha256: offer.file.sha256,
      }));
    }
    const result = await completion;
    if (result.kind === "transfer-error") throw new Error(result.message);
    if (result.sha256 !== offer.file.sha256 || result.bytes !== offer.file.size) throw new Error("接收端返回了无效的完整性确认。");
    onProgress?.(offer.file.size, offer.file.size);
    return result;
  } finally {
    acknowledgements.dispose();
    waitController.abort(new DOMException("线路发送已结束。", "AbortError"));
  }
}

export class MultipathChannelReceiver {
  readonly completion: Promise<ChannelReceiveResult>;
  private resolveCompletion!: (result: ChannelReceiveResult) => void;
  private rejectCompletion!: (error: unknown) => void;
  private sink: ReceiveSink | null = null;
  private hasher = createSha256Hasher();
  private nextSequence = 0;
  private receivedBytes = 0;
  private queue = Promise.resolve();
  private settled = false;
  private routes = new Map<RealtimeMethod, RTCDataChannel>();
  private routeQueues = new Map<RealtimeMethod, Promise<void>>();
  private externalRoutes = new Set<TransferMethod>();
  private routeCandidates: Set<TransferMethod>;

  constructor(
    private readonly offer: MultipathTransferOffer,
    private readonly target: ReceiveTarget,
    private readonly signal: AbortSignal,
    private readonly onProgress?: (bytes: number, total: number) => void,
    private readonly encryptionKey?: CryptoKey | null,
  ) {
    this.routeCandidates = new Set(offer.routes.map((route) => route.kind));
    this.completion = new Promise<ChannelReceiveResult>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    signal.addEventListener("abort", () => void this.fail(abortReason(signal)), { once: true });
  }

  get activeRouteCount() {
    return this.routeCandidates.size;
  }

  get isSettled() {
    return this.settled;
  }

  startExternalRoute(method: TransferMethod) {
    if (this.settled) return false;
    this.routeCandidates.add(method);
    this.externalRoutes.add(method);
    return true;
  }

  acceptExternalChunk(method: TransferMethod, sequence: number, payload: Uint8Array) {
    if (!this.externalRoutes.has(method)) return Promise.reject(new Error(`${method} 外部线路尚未启动。`));
    return this.acceptDataFrame({ sequence, payload });
  }

  completeExternalRoute(method: TransferMethod) {
    if (!this.externalRoutes.has(method)) return Promise.reject(new Error(`${method} 外部线路尚未启动。`));
    return this.enqueue(async () => {
      if (this.nextSequence === this.offer.file.totalChunks) await this.finish(method);
      else throw new Error(`${method} 线路在所有文件分块到达前结束。`);
    });
  }

  async failExternalRoute(method: TransferMethod, error: unknown) {
    this.externalRoutes.delete(method);
    await this.retireRoute(method, error);
  }

  async markRouteUnavailable(method: TransferMethod, error: unknown) {
    await this.retireRoute(method, error);
  }

  attach(route: RouteChannel) {
    if (this.settled) return () => undefined;
    this.routeCandidates.add(route.method);
    this.routes.set(route.method, route.channel);
    route.channel.binaryType = "arraybuffer";
    const onMessage = (event: MessageEvent) => {
      const previous = this.routeQueues.get(route.method) ?? Promise.resolve();
      const next = previous
        .then(() => this.handleMessage(route.method, route.channel, event.data))
        .catch((error) => this.failRoute(route.method, route.channel, error));
      this.routeQueues.set(route.method, next);
    };
    const onClose = () => {
      this.routes.delete(route.method);
      void this.retireRoute(route.method, new Error(`${route.method} 传输线路已断开。`));
    };
    route.channel.addEventListener("message", onMessage);
    route.channel.addEventListener("close", onClose);
    return () => {
      route.channel.removeEventListener("message", onMessage);
      route.channel.removeEventListener("close", onClose);
      this.routes.delete(route.method);
      this.routeQueues.delete(route.method);
    };
  }

  private async handleMessage(method: RealtimeMethod, channel: RTCDataChannel, data: unknown) {
    if (this.settled) return;
    throwIfAborted(this.signal);
    if (typeof data === "string") {
      const message = decodeControlMessage(data);
      if (message.transferId !== this.offer.transferId) return;
      if (message.kind === "transfer-done") {
        await this.enqueue(async () => {
          if (message.totalChunks !== this.offer.file.totalChunks || message.sha256 !== this.offer.file.sha256) {
            throw new Error(`${method} 线路声明的文件信息不一致。`);
          }
          if (this.nextSequence === this.offer.file.totalChunks) await this.finish(method);
        });
      }
      return;
    }
    const frame = decodeFileFrame(await messageDataToBuffer(data));
    if (frame.kind === "probe") {
      channel.send(encodeControlMessage({ kind: "probe-ack", transferId: this.offer.transferId, probeId: frame.sequence, bytes: frame.payload.byteLength }));
      return;
    }
    await this.acceptDataFrame(frame);
    if (channel.readyState === "open") {
      try {
        channel.send(encodeControlMessage({ kind: "chunk-ack", transferId: this.offer.transferId, sequence: frame.sequence }));
      } catch { /* the sender will observe channel close or timeout */ }
    }
  }

  private acceptDataFrame(frame: { sequence: number; payload: Uint8Array }) {
    return this.enqueue(async () => {
      if (frame.sequence < this.nextSequence) return;
      if (frame.sequence !== this.nextSequence) throw new Error("收到乱序文件分块，传输已停止。");
      const payload = this.offer.encryption
        ? await decryptTransferChunk(assertEncryptionKey(this.encryptionKey), this.offer.encryption, frame.sequence, frame.payload)
        : frame.payload;
      const expected = Math.min(this.offer.file.chunkSize, this.offer.file.size - frame.sequence * this.offer.file.chunkSize);
      if (payload.byteLength !== expected) throw new Error(`文件分块 ${frame.sequence} 大小不正确。`);
      if (!this.sink) this.sink = await openReceiveSink(this.target, this.offer.file.type);
      this.hasher.update(payload);
      await this.sink.write(payload);
      this.receivedBytes += payload.byteLength;
      this.nextSequence += 1;
      this.onProgress?.(this.receivedBytes, this.offer.file.size);
    });
  }

  private enqueue(work: () => Promise<void>) {
    const operation = this.queue.then(work);
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async failRoute(method: RealtimeMethod, channel: RTCDataChannel, error: unknown) {
    this.routes.delete(method);
    this.routeQueues.delete(method);
    const normalized = error instanceof Error ? error : new Error(`${method} 线路数据无效。`);
    if (channel.readyState === "open") {
      try {
        channel.send(encodeControlMessage({ kind: "transfer-error", transferId: this.offer.transferId, message: normalized.message.slice(0, 500) }));
      } catch { /* best effort */ }
    }
    try { channel.close(); } catch { /* already closing */ }
    await this.retireRoute(method, normalized);
  }

  private async retireRoute(method: TransferMethod, error: unknown) {
    this.routeCandidates.delete(method);
    if (!this.settled && this.routeCandidates.size === 0) await this.fail(error);
  }

  private async finish(method: TransferMethod) {
    if (this.settled) return;
    if (!this.sink) this.sink = await openReceiveSink(this.target, this.offer.file.type);
    if (this.receivedBytes !== this.offer.file.size) throw new Error("文件大小校验失败。");
    const digest = this.hasher.digestHex();
    if (digest !== this.offer.file.sha256) throw new Error("文件完整性校验失败：SHA-256 不一致。");
    const blob = await this.sink.close();
    if (blob) {
      const url = URL.createObjectURL(blob);
      saveBlob({ name: this.offer.file.name, url });
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    const result = { route: method, bytes: this.receivedBytes, sha256: digest, savedToDisk: this.sink.kind === "file-system", targetName: this.sink.name };
    this.settled = true;
    this.resolveCompletion(result);
    const confirmation = encodeControlMessage({ kind: "transfer-complete", transferId: this.offer.transferId, route: method, bytes: this.receivedBytes, sha256: digest });
    for (const channel of this.routes.values()) {
      if (channel.readyState !== "open") continue;
      try { channel.send(confirmation); } catch { /* local verification already completed */ }
    }
  }

  async fail(error: unknown) {
    if (this.settled) return;
    const normalized = error instanceof Error ? error : new Error("实时文件传输失败。");
    if (this.sink) await this.sink.abort().catch(() => undefined);
    this.settled = true;
    this.rejectCompletion(normalized);
    const message = encodeControlMessage({ kind: "transfer-error", transferId: this.offer.transferId, message: normalized.message.slice(0, 500) });
    for (const channel of this.routes.values()) {
      if (channel.readyState !== "open") continue;
      try { channel.send(message); } catch { /* best-effort remote notification */ }
    }
  }
}

export type ChannelReceiveResult = { route: TransferMethod; bytes: number; sha256: string; savedToDisk: boolean; targetName: string };

export async function sendWithBackpressure(channel: RTCDataChannel, value: ArrayBufferView, signal: AbortSignal) {
  throwIfAborted(signal);
  await waitForChannelOpen(channel, signal);
  const highWaterMark = 4 * 1024 * 1024;
  const lowWaterMark = 512 * 1024;
  if (channel.bufferedAmount > highWaterMark) {
    channel.bufferedAmountLowThreshold = lowWaterMark;
    await waitForEvent(channel, "bufferedamountlow", signal, 30_000);
  }
  throwIfAborted(signal);
  channel.send(value as ArrayBufferView<ArrayBuffer>);
}

export async function waitForChannelOpen(channel: RTCDataChannel, signal: AbortSignal) {
  if (channel.readyState === "open") return;
  if (channel.readyState === "closing" || channel.readyState === "closed") throw new Error("数据通道已关闭。");
  await waitForEvent(channel, "open", signal, 30_000);
}

function createChunkAckTracker(channel: RTCDataChannel, transferId: string, signal: AbortSignal) {
  const maxInFlightChunks = 32;
  let highestAcknowledged = -1;
  let failure: Error | null = null;
  const waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const wake = () => {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    try {
      const message = decodeControlMessage(event.data);
      if (message.kind !== "chunk-ack" || message.transferId !== transferId) return;
      highestAcknowledged = Math.max(highestAcknowledged, message.sequence);
      wake();
    } catch { /* another listener owns this message */ }
  };
  const onClose = () => fail(new Error("数据通道已关闭。"));
  const onAbort = () => fail(abortReason(signal));
  channel.addEventListener("message", onMessage);
  channel.addEventListener("close", onClose, { once: true });
  signal.addEventListener("abort", onAbort, { once: true });

  return {
    async waitForCredit(sequence: number) {
      while (sequence - highestAcknowledged > maxInFlightChunks) {
        if (failure) throw failure;
        await new Promise<void>((resolve, reject) => waiters.add({ resolve, reject }));
      }
    },
    dispose() {
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      fail(new DOMException("分块确认等待已结束。", "AbortError"));
    },
  };
}

function waitForControl<T extends TransferControlMessage>(
  channel: RTCDataChannel,
  signal: AbortSignal,
  matches: (message: TransferControlMessage) => message is T,
  timeoutMs?: number,
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = timeoutMs === undefined
      ? undefined
      : window.setTimeout(() => finish(new Error("等待接收端响应超时。")), timeoutMs);
    const onAbort = () => finish(abortReason(signal));
    const onClose = () => finish(new Error("数据通道已关闭。"));
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const message = decodeControlMessage(event.data);
        if (matches(message)) finish(undefined, message);
      } catch { /* another protocol listener owns this message */ }
    };
    const finish = (error?: Error, value?: T) => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("message", onMessage);
      if (error) reject(error); else resolve(value!);
    };
    if (signal.aborted) { finish(abortReason(signal)); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    channel.addEventListener("close", onClose, { once: true });
    channel.addEventListener("message", onMessage);
  });
}

function waitForEvent(target: EventTarget, type: string, signal: AbortSignal, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error(`等待 ${type} 超时。`)), timeoutMs);
    const onAbort = () => finish(abortReason(signal));
    const onEvent = () => finish();
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      target.removeEventListener(type, onEvent);
      if (error) reject(error); else resolve();
    };
    if (signal.aborted) { finish(abortReason(signal)); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    target.addEventListener(type, onEvent, { once: true });
  });
}

function randomUint32() { const values = new Uint32Array(1); crypto.getRandomValues(values); return values[0]; }
function assertEncryptionKey(key: CryptoKey | null | undefined) {
  if (!key) throw new Error("这个文件需要通过包含端到端密钥的分享链接接收。");
  return key;
}
function abortReason(signal: AbortSignal) { return signal.reason instanceof Error ? signal.reason : new DOMException("操作已取消。", "AbortError"); }
function linkedAbortController(parent: AbortSignal) {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return controller;
}

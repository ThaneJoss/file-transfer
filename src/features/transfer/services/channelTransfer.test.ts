import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeControlMessage, encodeFileFrame } from "../protocol/fileFrames";
import { fileTransferProtocolKind } from "../protocol/fileProtocol";
import type { MultipathTransferOffer } from "../protocol/fileProtocol";
import { MultipathChannelReceiver, sendFileOnChannel } from "./channelTransfer";

const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const alphabetSha256 = "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  sent: unknown[] = [];
  throwOnSend = false;
  send(value: unknown) { if (this.throwOnSend) throw new DOMException("closed", "InvalidStateError"); this.sent.push(value); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  push(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}

describe("multipath channel receiver", () => {
  it("writes a duplicated turbo chunk exactly once and acknowledges all routes", async () => {
    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174001",
      mode: "turbo",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174002",
        name: "hello.txt",
        size: 5,
        type: "text/plain",
        lastModified: 1,
        sha256: helloSha256,
        chunkSize: 48 * 1024,
        totalChunks: 1,
      },
      routes: [],
    };
    const writes: Uint8Array[] = [];
    const writable = {
      write: vi.fn(async (value: ArrayBuffer) => writes.push(new Uint8Array(value))),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const target = {
      kind: "file-system" as const,
      handle: { name: "hello.txt", createWritable: async () => writable } as unknown as FileSystemFileHandle,
    };
    const controller = new AbortController();
    const receiver = new MultipathChannelReceiver(offer, target, controller.signal);
    const direct = new FakeDataChannel();
    const stun = new FakeDataChannel();
    receiver.attach({ method: "direct", channel: direct as unknown as RTCDataChannel, dispose: () => direct.close() });
    receiver.attach({ method: "stun", channel: stun as unknown as RTCDataChannel, dispose: () => stun.close() });

    const frame = encodeFileFrame("data", 0, new TextEncoder().encode("hello"));
    direct.push(frame);
    stun.push(frame);
    direct.push(encodeControlMessage({ kind: "transfer-done", transferId: offer.transferId, totalChunks: 1, sha256: helloSha256 }));

    await expect(receiver.completion).resolves.toMatchObject({ route: "direct", bytes: 5, sha256: helloSha256 });
    expect(writes).toHaveLength(1);
    expect(new TextDecoder().decode(writes[0])).toBe("hello");
    expect(writable.close).toHaveBeenCalledOnce();
    expect(direct.sent).toHaveLength(2);
    expect(stun.sent).toHaveLength(2);
  });

  it("receives an R2-only external stream and settles even if a channel ack throws", async () => {
    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174011",
      mode: "turbo",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174012",
        name: "hello.txt",
        size: 5,
        type: "text/plain",
        lastModified: 1,
        sha256: helloSha256,
        chunkSize: 48 * 1024,
        totalChunks: 1,
      },
      routes: [],
    };
    const writable = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const target = {
      kind: "file-system" as const,
      handle: { name: "hello.txt", createWritable: async () => writable } as unknown as FileSystemFileHandle,
    };
    const receiver = new MultipathChannelReceiver(offer, target, new AbortController().signal);
    const closing = new FakeDataChannel();
    receiver.attach({ method: "direct", channel: closing as unknown as RTCDataChannel, dispose: () => undefined });
    closing.throwOnSend = true;
    receiver.startExternalRoute("r2");
    await receiver.acceptExternalChunk("r2", 0, new TextEncoder().encode("hello"));
    await receiver.completeExternalRoute("r2");

    await expect(receiver.completion).resolves.toMatchObject({ route: "r2", bytes: 5, sha256: helloSha256 });
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it("does not fail while another offered route is still pending", async () => {
    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174021",
      mode: "auto",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174022",
        name: "hello.txt",
        size: 5,
        type: "text/plain",
        lastModified: 1,
        sha256: helloSha256,
        chunkSize: 48 * 1024,
        totalChunks: 1,
      },
      routes: [{ kind: "stun", signal: { description: { type: "offer", sdp: "" }, candidates: [] } }],
    };
    const writable = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const target = {
      kind: "file-system" as const,
      handle: { name: "hello.txt", createWritable: async () => writable } as unknown as FileSystemFileHandle,
    };
    const receiver = new MultipathChannelReceiver(offer, target, new AbortController().signal);
    const direct = new FakeDataChannel();
    receiver.attach({ method: "direct", channel: direct as unknown as RTCDataChannel, dispose: () => undefined });
    direct.close();
    await Promise.resolve();
    expect(receiver.isSettled).toBe(false);

    const stun = new FakeDataChannel();
    receiver.attach({ method: "stun", channel: stun as unknown as RTCDataChannel, dispose: () => undefined });
    stun.push(encodeFileFrame("data", 0, new TextEncoder().encode("hello")));
    stun.push(encodeControlMessage({ kind: "transfer-done", transferId: offer.transferId, totalChunks: 1, sha256: helloSha256 }));

    await expect(receiver.completion).resolves.toMatchObject({ route: "stun", bytes: 5 });
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it("deduplicates interleaved multi-chunk turbo routes", async () => {
    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174031",
      mode: "turbo",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174032",
        name: "alphabet.txt",
        size: 6,
        type: "text/plain",
        lastModified: 1,
        sha256: alphabetSha256,
        chunkSize: 2,
        totalChunks: 3,
      },
      routes: [],
    };
    const writes: Uint8Array[] = [];
    const writable = {
      write: vi.fn(async (value: ArrayBuffer) => writes.push(new Uint8Array(value))),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const target = {
      kind: "file-system" as const,
      handle: { name: "alphabet.txt", createWritable: async () => writable } as unknown as FileSystemFileHandle,
    };
    const receiver = new MultipathChannelReceiver(offer, target, new AbortController().signal);
    const direct = new FakeDataChannel();
    const stun = new FakeDataChannel();
    receiver.attach({ method: "direct", channel: direct as unknown as RTCDataChannel, dispose: () => undefined });
    receiver.attach({ method: "stun", channel: stun as unknown as RTCDataChannel, dispose: () => undefined });

    direct.push(encodeFileFrame("data", 0, new TextEncoder().encode("ab")));
    stun.push(encodeFileFrame("data", 0, new TextEncoder().encode("ab")));
    stun.push(encodeFileFrame("data", 1, new TextEncoder().encode("cd")));
    direct.push(encodeFileFrame("data", 1, new TextEncoder().encode("cd")));
    direct.push(encodeFileFrame("data", 2, new TextEncoder().encode("ef")));
    stun.push(encodeFileFrame("data", 2, new TextEncoder().encode("ef")));
    stun.push(encodeControlMessage({ kind: "transfer-done", transferId: offer.transferId, totalChunks: 3, sha256: alphabetSha256 }));

    await expect(receiver.completion).resolves.toMatchObject({ bytes: 6, sha256: alphabetSha256 });
    expect(writes).toHaveLength(3);
    expect(new TextDecoder().decode(new Uint8Array(writes.flatMap((chunk) => [...chunk])))).toBe("abcdef");
  });
});

describe("channel sender progress deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startSender(totalChunks = 40) {
    const channel = new FakeDataChannel();
    const controller = new AbortController();
    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174051",
      mode: "auto",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174052",
        name: "deadline.bin",
        size: totalChunks,
        type: "application/octet-stream",
        lastModified: 1,
        sha256: helloSha256,
        chunkSize: 1,
        totalChunks,
      },
      routes: [],
    };
    // Keep file reads entirely in the microtask queue under fake timers.
    const file = {
      slice: (start: number, end: number) => ({
        arrayBuffer: async () => new Uint8Array(end - start).buffer,
      }),
    } as unknown as File;
    const removeChannelListener = vi.spyOn(channel, "removeEventListener");
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const operation = sendFileOnChannel({
      route: { method: "direct", channel: channel as unknown as RTCDataChannel, dispose: () => channel.close() },
      offer,
      file,
      signal: controller.signal,
    });
    const ack = (sequence: number, transferId = offer.transferId) => channel.push(encodeControlMessage({
      kind: "chunk-ack", transferId, sequence,
    }));
    const complete = () => channel.push(encodeControlMessage({
      kind: "transfer-complete",
      transferId: offer.transferId,
      route: "direct",
      bytes: offer.file.size,
      sha256: offer.file.sha256,
    }));
    const dataFrames = () => channel.sent.filter((message) => typeof message !== "string");
    const expectCleanedUp = () => {
      expect(vi.getTimerCount()).toBe(0);
      expect(removeChannelListener).toHaveBeenCalledWith("message", expect.any(Function));
      expect(removeChannelListener).toHaveBeenCalledWith("close", expect.any(Function));
      expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    };
    return { channel, controller, offer, operation, ack, complete, dataFrames, expectCleanedUp };
  }

  it("times out after 32 unacknowledged chunks and releases its listeners", async () => {
    vi.useFakeTimers();
    const sender = startSender();
    const assertion = expect(sender.operation).rejects.toThrow("分块确认超时");
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.dataFrames()).toHaveLength(32);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sender.dataFrames()).toHaveLength(32);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    sender.expectCleanedUp();
  });

  it.each([0, 1, 32])("times out final confirmation for a %i-chunk file", async (chunks) => {
    vi.useFakeTimers();
    const sender = startSender(chunks);
    const assertion = expect(sender.operation).rejects.toThrow("完成确认超时");
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.dataFrames()).toHaveLength(chunks);
    expect(sender.channel.sent.some((message) => typeof message === "string" && JSON.parse(message).kind === "transfer-done")).toBe(true);
    if (chunks > 0) sender.ack(chunks - 1);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    sender.expectCleanedUp();
  });

  it("refreshes on advancing ACKs so a progressing transfer can exceed 30 seconds", async () => {
    vi.useFakeTimers();
    const sender = startSender(70);
    const assertion = expect(sender.operation).resolves.toMatchObject({ kind: "transfer-complete", bytes: 70 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.dataFrames()).toHaveLength(32);

    await vi.advanceTimersByTimeAsync(29_000);
    sender.ack(31);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.dataFrames()).toHaveLength(64);

    await vi.advanceTimersByTimeAsync(29_000);
    sender.ack(63);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.dataFrames()).toHaveLength(70);

    await vi.advanceTimersByTimeAsync(29_000);
    sender.ack(69);
    await vi.advanceTimersByTimeAsync(29_000);
    sender.complete();
    await assertion;
    sender.expectCleanedUp();
  });

  it("ignores duplicate, unsent and other-transfer ACKs when measuring progress", async () => {
    vi.useFakeTimers();
    const sender = startSender(70);
    const assertion = expect(sender.operation).rejects.toThrow("分块确认超时");
    await vi.advanceTimersByTimeAsync(0);
    sender.ack(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.dataFrames()).toHaveLength(33);
    await vi.advanceTimersByTimeAsync(29_000);
    sender.ack(0);
    sender.ack(69);
    sender.ack(32, "another-transfer");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(sender.dataFrames()).toHaveLength(33);
    sender.expectCleanedUp();
  });

  it("releases a blocked credit wait immediately on transfer-error", async () => {
    vi.useFakeTimers();
    const sender = startSender();
    const assertion = expect(sender.operation).rejects.toThrow("接收端写入失败");
    await vi.advanceTimersByTimeAsync(0);
    sender.channel.push(encodeControlMessage({
      kind: "transfer-error", transferId: sender.offer.transferId, message: "接收端写入失败",
    }));
    await assertion;
    expect(sender.dataFrames()).toHaveLength(32);
    expect(sender.channel.sent.every((message) => typeof message !== "string")).toBe(true);
    sender.expectCleanedUp();
  });

  it("accepts another route's completion while blocked for credit", async () => {
    vi.useFakeTimers();
    const sender = startSender();
    const assertion = expect(sender.operation).resolves.toMatchObject({ kind: "transfer-complete" });
    await vi.advanceTimersByTimeAsync(0);
    sender.complete();
    await assertion;
    expect(sender.dataFrames()).toHaveLength(32);
    expect(sender.channel.sent.every((message) => typeof message !== "string")).toBe(true);
    sender.expectCleanedUp();
  });

  it("cleans up a pending credit wait on local cancellation", async () => {
    vi.useFakeTimers();
    const sender = startSender();
    const assertion = expect(sender.operation).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    sender.controller.abort(new DOMException("cancelled", "AbortError"));
    await assertion;
    sender.expectCleanedUp();
  });

  it("cleans up a pending credit wait when the channel closes", async () => {
    vi.useFakeTimers();
    const sender = startSender();
    const assertion = expect(sender.operation).rejects.toThrow("数据通道已关闭");
    await vi.advanceTimersByTimeAsync(0);
    sender.channel.close();
    await assertion;
    sender.expectCleanedUp();
  });
});

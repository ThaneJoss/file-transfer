import { describe, expect, it, vi } from "vitest";

import { encodeControlMessage, encodeFileFrame } from "../protocol/fileFrames";
import { createTransferEncryption, encryptTransferChunk } from "../crypto/fileEncryption";
import { encryptedFileTransferProtocolKind, fileTransferProtocolKind } from "../protocol/fileProtocol";
import type { MultipathTransferOffer } from "../protocol/fileProtocol";
import { MultipathChannelReceiver } from "./channelTransfer";

const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const alphabetSha256 = "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721";

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  readyState: RTCDataChannelState = "open";
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

  it("decrypts and verifies authenticated v4 chunks before writing them", async () => {
    const encryption = await createTransferEncryption();
    const offer: MultipathTransferOffer = {
      kind: encryptedFileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174051",
      mode: "auto",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174052",
        name: "hello.txt",
        size: 5,
        type: "text/plain",
        lastModified: 1,
        sha256: helloSha256,
        chunkSize: 48 * 1024,
        totalChunks: 1,
      },
      routes: [{
        kind: "r2",
        objectKey: "users/test/hello.txt",
        downloadUrl: "https://example.r2.cloudflarestorage.com/bucket/hello.txt?signature=test",
        expiresAt: Date.now() + 60_000,
        probeSize: 5,
        probeSha256: helloSha256,
        contentSize: 21,
      }],
      encryption: encryption.metadata,
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
    const receiver = new MultipathChannelReceiver(
      offer,
      target,
      new AbortController().signal,
      undefined,
      encryption.key,
    );
    receiver.startExternalRoute("r2");
    const ciphertext = await encryptTransferChunk(
      encryption.key,
      encryption.metadata,
      0,
      new TextEncoder().encode("hello"),
    );
    await receiver.acceptExternalChunk("r2", 0, ciphertext);
    await receiver.completeExternalRoute("r2");

    await expect(receiver.completion).resolves.toMatchObject({ route: "r2", bytes: 5, sha256: helloSha256 });
    expect(new TextDecoder().decode(writes[0])).toBe("hello");
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

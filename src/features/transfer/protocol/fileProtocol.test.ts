import { describe, expect, it } from "vitest";

import { encodeConnectionPayload } from "./connectionCode";
import {
  decodeTransferAnswer,
  assertR2TransferDescriptor,
  decodeTransferOffer,
  decodeTransferDescriptor,
  encodeTransferAnswer,
  encodeTransferDescriptor,
  encodeTransferOffer,
  encryptedFileTransferProtocolKind,
  fileTransferAnswerKind,
  fileTransferProtocolKind,
  legacyFileTransferProtocolKind,
} from "./fileProtocol";
import type { MultipathTransferAnswer, MultipathTransferOffer, R2TransferDescriptor } from "./fileProtocol";

const descriptor: R2TransferDescriptor = {
  kind: legacyFileTransferProtocolKind,
  createdAt: 1_700_000_000_000,
  file: {
    id: "123e4567-e89b-42d3-a456-426614174000",
    name: "demo.bin",
    size: 5,
    type: "application/octet-stream",
    lastModified: 123,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
  route: {
    kind: "r2",
    objectKey: "users/demo.bin",
    downloadUrl: "https://example.r2.cloudflarestorage.com/bucket/demo.bin?X-Amz-Signature=test",
    expiresAt: 1_800_000_000_000,
  },
};

const multipathOffer: MultipathTransferOffer = {
  kind: fileTransferProtocolKind,
  transferId: "123e4567-e89b-42d3-a456-426614174001",
  mode: "auto",
  createdAt: 1_700_000_000_000,
  file: {
    id: "123e4567-e89b-42d3-a456-426614174002",
    name: "demo.bin",
    size: 5,
    type: "application/octet-stream",
    lastModified: 123,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    chunkSize: 48 * 1024,
    totalChunks: 1,
  },
  routes: [{
    kind: "r2",
    objectKey: "users/demo.bin",
    downloadUrl: "https://example.r2.cloudflarestorage.com/bucket/demo.bin?X-Amz-Signature=test",
    expiresAt: 1_800_000_000_000,
    probeSize: 5,
    probeSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  }],
};

describe("file transfer protocol", () => {
  it("round trips a v2 descriptor", async () => {
    const encoded = await encodeTransferDescriptor(descriptor);
    await expect(decodeTransferDescriptor(encoded)).resolves.toEqual(descriptor);
  });

  it("round trips a v3 multipath offer and answer", async () => {
    await expect(decodeTransferOffer(await encodeTransferOffer(multipathOffer))).resolves.toEqual(multipathOffer);
    const answer: MultipathTransferAnswer = {
      kind: fileTransferAnswerKind,
      transferId: multipathOffer.transferId,
      routes: [{
        kind: "sfu",
        descriptor: {
          kind: "cloudflare-calls-datachannel-duplex-answer-v2",
          publisherSessionId: "receiver-session",
          dataChannelName: "reverse-channel",
        },
      }],
      metrics: { r2: { bytes: 5, elapsedMs: 12 } },
    };
    await expect(decodeTransferAnswer(await encodeTransferAnswer(answer))).resolves.toEqual(answer);
  });

  it("round trips v4 encryption metadata without embedding the secret key", async () => {
    const encryptedOffer: MultipathTransferOffer = {
      ...multipathOffer,
      kind: encryptedFileTransferProtocolKind,
      encryption: {
        algorithm: "AES-GCM-256",
        keyId: "ab".repeat(32),
        noncePrefix: "AQIDBAUGBwg",
        tagBytes: 16,
      },
      routes: multipathOffer.routes.map((route) => route.kind === "r2"
        ? { ...route, contentSize: multipathOffer.file.size + 16 }
        : route),
    };
    const encoded = await encodeTransferOffer(encryptedOffer);

    await expect(decodeTransferOffer(encoded)).resolves.toEqual(encryptedOffer);
    expect(encoded).not.toContain("secret");
  });

  it("rejects v4 R2 offers that omit the encrypted object size", async () => {
    const invalid = {
      ...multipathOffer,
      kind: encryptedFileTransferProtocolKind,
      encryption: {
        algorithm: "AES-GCM-256",
        keyId: "ab".repeat(32),
        noncePrefix: "AQIDBAUGBwg",
        tagBytes: 16,
      },
    } as MultipathTransferOffer;

    await expect(encodeTransferOffer(invalid)).rejects.toThrow("文件传输协议格式不正确");
  });

  it("allows unavailable routes but rejects duplicate route identities", async () => {
    await expect(decodeTransferOffer(await encodeTransferOffer(multipathOffer))).resolves.toMatchObject({ routes: [{ kind: "r2" }] });
    const invalid = { ...multipathOffer, routes: [...multipathOffer.routes, multipathOffer.routes[0]] };
    await expect(encodeTransferOffer(invalid)).rejects.toThrow("文件传输协议格式不正确");
  });

  it("rejects manifests whose frame sequence would exceed uint32", async () => {
    const totalChunks = 0x1_0000_0001;
    const invalid = {
      ...multipathOffer,
      file: {
        ...multipathOffer.file,
        size: totalChunks * multipathOffer.file.chunkSize,
        totalChunks,
      },
    };
    await expect(encodeTransferOffer(invalid)).rejects.toThrow("文件传输协议格式不正确");
  });

  it("normalizes a legacy R2 descriptor for size-only verification", async () => {
    const encoded = await encodeConnectionPayload({
      kind: "cloudflare-r2-file-v1",
      objectKey: "legacy/demo.txt",
      presignedUrl: "https://example.r2.cloudflarestorage.com/bucket/demo.txt?signature=test",
      expiresAt: 1_800_000_000_000,
      file: { name: "demo.txt", size: 4, type: "text/plain", lastModified: 10 },
    });
    const result = await decodeTransferDescriptor(encoded);

    expect(result.route.kind).toBe("r2");
    expect(result.file).toMatchObject({ name: "demo.txt", size: 4, sha256: null });
  });

  it("rejects unsafe routes, invalid sizes, and missing hashes", () => {
    expect(() => assertR2TransferDescriptor({ ...descriptor, route: { ...descriptor.route, downloadUrl: "http://example.com/file" } })).toThrow(
      "文件传输协议格式不正确",
    );
    expect(() => assertR2TransferDescriptor({ ...descriptor, file: { ...descriptor.file, size: -1 } })).toThrow(
      "文件传输协议格式不正确",
    );
    expect(() => assertR2TransferDescriptor({ ...descriptor, file: { ...descriptor.file, sha256: "missing" } })).toThrow(
      "文件传输协议格式不正确",
    );
    expect(() => assertR2TransferDescriptor({ ...descriptor, route: { ...descriptor.route, objectKey: "x".repeat(1025) } })).toThrow(
      "文件传输协议格式不正确",
    );
    expect(() => assertR2TransferDescriptor({ ...descriptor, file: { ...descriptor.file, name: "../demo.bin" } })).toThrow(
      "文件传输协议格式不正确",
    );
  });

  it("rejects a non-object payload as a protocol error", async () => {
    const encoded = await encodeConnectionPayload("not-json");
    await expect(decodeTransferDescriptor(encoded)).rejects.toThrow("文件传输协议格式不正确");
  });
});

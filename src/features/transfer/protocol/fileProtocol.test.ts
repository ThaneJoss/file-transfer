import { describe, expect, it } from "vitest";

import { encodeConnectionPayload } from "./connectionCode";
import {
  assertR2TransferDescriptor,
  decodeTransferDescriptor,
  encodeTransferDescriptor,
  fileTransferProtocolKind,
} from "./fileProtocol";
import type { R2TransferDescriptor } from "./fileProtocol";

const descriptor: R2TransferDescriptor = {
  kind: fileTransferProtocolKind,
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

describe("file transfer protocol", () => {
  it("round trips a v2 descriptor", async () => {
    const encoded = await encodeTransferDescriptor(descriptor);
    await expect(decodeTransferDescriptor(encoded)).resolves.toEqual(descriptor);
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

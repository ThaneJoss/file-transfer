import { describe, expect, it } from "vitest";

import {
  createSha256Hasher,
  decodeSfuFileChunk,
  encodeSfuFileChunk,
  getSfuChunkPayloadSize,
  openReceiveSink,
  sfuChunkHeaderSize,
  sha256File,
} from "./fileTransfer";

const fileId = "12345678-1234-4234-9234-1234567890ab";

describe("SFU file transfer protocol", () => {
  it("caps payloads below the negotiated SCTP message size", () => {
    expect(getSfuChunkPayloadSize(asPeer(32 * 1024))).toBe(32 * 1024 - sfuChunkHeaderSize);
    expect(getSfuChunkPayloadSize(asPeer(256 * 1024))).toBe(64 * 1024 - sfuChunkHeaderSize);
    expect(getSfuChunkPayloadSize(asPeer(undefined))).toBe(16 * 1024 - sfuChunkHeaderSize);
  });

  it("encodes file id and sequence in every binary chunk", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const encoded = encodeSfuFileChunk(fileId, 17, payload);
    expect(encoded.byteLength).toBe(sfuChunkHeaderSize + payload.byteLength);
    expect(decodeSfuFileChunk(encoded)).toEqual({ fileId, sequence: 17, payload });
  });

  it("hashes files and received chunks incrementally", async () => {
    const file = new Blob(["hello", " world"]);
    const expected = await sha256File(file);
    const received = createSha256Hasher();
    received.update(new TextEncoder().encode("hello"));
    received.update(new TextEncoder().encode(" world"));
    expect(received.digestHex()).toBe(expected);
  });

  it("uses a bounded-memory fallback sink to assemble small files", async () => {
    const sink = await openReceiveSink({ kind: "memory" }, "text/plain");
    await sink.write(new TextEncoder().encode("hello "));
    await sink.write(new TextEncoder().encode("world"));
    const blob = await sink.close();
    expect(blob).not.toBeNull();
    await expect(blob!.text()).resolves.toBe("hello world");
  });

  it("writes supported-browser chunks directly to the selected file", async () => {
    const writes: Uint8Array[] = [];
    let closed = false;
    const handle = {
      name: "saved.bin",
      async createWritable() {
        return {
          async write(value: ArrayBuffer) {
            writes.push(new Uint8Array(value));
          },
          async close() {
            closed = true;
          },
          async abort() {},
        };
      },
    } as unknown as FileSystemFileHandle;

    const sink = await openReceiveSink({ kind: "file-system", handle }, "application/octet-stream");
    await sink.write(new Uint8Array([1, 2]));
    await sink.write(new Uint8Array([3, 4]));
    await expect(sink.close()).resolves.toBeNull();
    expect(writes).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    expect(closed).toBe(true);
  });
});

function asPeer(maxMessageSize: number | undefined) {
  return {
    sctp: maxMessageSize === undefined ? null : { maxMessageSize },
  } as unknown as RTCPeerConnection;
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamR2FileWhenReady } from "./r2Transfer";

describe("R2 streaming", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not read the restored response ahead of a blocked consumer", async () => {
    const sourceChunkBytes = 1024;
    const expectedSize = 66 * sourceChunkBytes;
    let remaining = expectedSize;
    let sourceReads = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        sourceReads += 1;
        const size = Math.min(sourceChunkBytes, remaining);
        remaining -= size;
        controller.enqueue(new Uint8Array(size));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(source, { status: 200 })));

    let releaseFirstChunk!: () => void;
    const firstChunkBlocked = new Promise<void>((resolve) => { releaseFirstChunk = resolve; });
    let firstChunkStarted!: () => void;
    const firstChunk = new Promise<void>((resolve) => { firstChunkStarted = resolve; });
    const operation = streamR2FileWhenReady({
      route: {
        kind: "r2",
        objectKey: "users/test/probe.bin",
        downloadUrl: "https://r2.example.test/probe.bin",
        expiresAt: Date.now() + 60_000,
        probeSize: sourceChunkBytes,
        probeSha256: "00".repeat(32),
      },
      expectedSize,
      expectedSha256: "00".repeat(32),
      chunkSize: sourceChunkBytes * 2,
      signal: new AbortController().signal,
      onChunk: async (sequence) => {
        if (sequence !== 0) return;
        firstChunkStarted();
        await firstChunkBlocked;
      },
    });

    await firstChunk;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sourceReads).toBeLessThan(10);

    releaseFirstChunk();
    await expect(operation).resolves.toEqual({ bytes: expectedSize, totalChunks: 33 });
    expect(sourceReads).toBe(66);
  });

  it("stops before polling R2 again after the download authorization expires", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamR2FileWhenReady({
      route: {
        kind: "r2",
        objectKey: "users/test/expired.bin",
        downloadUrl: "https://r2.example.test/expired.bin",
        expiresAt: Date.now() - 1,
        probeSize: 1,
        probeSha256: "00".repeat(32),
      },
      expectedSize: 66 * 1024,
      expectedSha256: "00".repeat(32),
      chunkSize: 1024,
      signal: new AbortController().signal,
      onChunk: async () => undefined,
    })).rejects.toThrow("R2 下载授权已过期");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

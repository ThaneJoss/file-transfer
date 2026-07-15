import { describe, expect, it } from "vitest";

import { bytesToBase64Url, decodeConnectionPayload } from "./connectionCode";

describe("bounded connection payloads", () => {
  it("rejects oversized encoded input before decoding", async () => {
    await expect(decodeConnectionPayload(`J1.${"A".repeat(384 * 1024 + 1)}`, "无法解压")).rejects.toThrow(
      "传输协议内容过大",
    );
  });

  it("stops decompression when the expanded payload exceeds the limit", async () => {
    const source = new Response("x".repeat(400_000)).body;
    if (!source) throw new Error("ReadableStream is unavailable in this test environment");
    const buffer = await new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const compressed = `D1.${bytesToBase64Url(new Uint8Array(buffer))}`;
    await expect(decodeConnectionPayload(compressed, "无法解压")).rejects.toThrow(
      "传输协议解压后内容过大",
    );
  });
});

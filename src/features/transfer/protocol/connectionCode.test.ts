import { describe, expect, it } from "vitest";

import { decodeConnectionPayload, encodeConnectionPayload } from "./connectionCode";

describe("bounded connection payloads", () => {
  it("rejects oversized encoded input before decoding", async () => {
    await expect(decodeConnectionPayload(`J1.${"A".repeat(80_001)}`, "无法解压")).rejects.toThrow(
      "传输协议内容过大",
    );
  });

  it("stops decompression when the expanded payload exceeds the limit", async () => {
    const compressed = await encodeConnectionPayload("x".repeat(300_000));
    await expect(decodeConnectionPayload(compressed, "无法解压")).rejects.toThrow(
      "传输协议解压后内容过大",
    );
  });
});

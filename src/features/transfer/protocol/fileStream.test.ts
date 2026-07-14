import { describe, expect, it } from "vitest";

import { receiveVerifiedResponse, sha256Blob } from "./fileStream";

const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("streaming file integrity", () => {
  it("hashes a Blob incrementally", async () => {
    const progress: number[] = [];
    const digest = await sha256Blob(new Blob(["hello"]), {
      onProgress: (bytes) => progress.push(bytes),
    });

    expect(digest).toBe(helloSha256);
    expect(progress).toEqual([0, 5]);
  });

  it("streams to memory and verifies exact size and SHA-256", async () => {
    const result = await receiveVerifiedResponse({
      response: new Response(new TextEncoder().encode("hello"), { status: 200 }),
      target: { kind: "memory" },
      expectedSize: 5,
      expectedSha256: helloSha256,
      mimeType: "text/plain",
    });

    expect(result.bytes).toBe(5);
    expect(result.sha256).toBe(helloSha256);
    expect(result.blob?.size).toBe(5);
  });

  it("rejects truncated and corrupted downloads", async () => {
    await expect(receiveVerifiedResponse({
      response: new Response(new TextEncoder().encode("hell"), { status: 200 }),
      target: { kind: "memory" },
      expectedSize: 5,
      expectedSha256: helloSha256,
      mimeType: "text/plain",
    })).rejects.toThrow("文件不完整");

    await expect(receiveVerifiedResponse({
      response: new Response(new TextEncoder().encode("HELLO"), { status: 200 }),
      target: { kind: "memory" },
      expectedSize: 5,
      expectedSha256: helloSha256,
      mimeType: "text/plain",
    })).rejects.toThrow("SHA-256 不一致");

    await expect(receiveVerifiedResponse({
      response: new Response(new TextEncoder().encode("hello!"), { status: 200 }),
      target: { kind: "memory" },
      expectedSize: 5,
      expectedSha256: null,
      mimeType: "text/plain",
    })).rejects.toThrow("超过协议声明大小");
  });

  it("stops before work when cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("测试取消", "AbortError"));

    await expect(sha256Blob(new Blob(["hello"]), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { fileTransferAnswerKind, fileTransferProtocolKind } from "../protocol/fileProtocol";
import type { MultipathTransferAnswer, MultipathTransferOffer } from "../protocol/fileProtocol";
import {
  assertWinnerMatches,
  linkedAbortController,
  rankTransferRoutes,
  settle,
  withRouteDeadline,
  withTimeout,
} from "./multipathCoordinator";
import type { ProbeResult } from "./channelTransfer";
import type { R2SenderSession } from "./r2Transfer";

const fileSize = 1024 * 1024;

function answer(r2?: { bytes: number; elapsedMs: number }): MultipathTransferAnswer {
  return {
    kind: fileTransferAnswerKind,
    transferId: "123e4567-e89b-42d3-a456-426614174041",
    routes: [],
    metrics: r2 ? { r2 } : {},
  };
}

function r2Session(probeUploadElapsedMs: number): R2SenderSession {
  return {
    probeUploadElapsedMs,
    multipartResume: { fingerprint: "test", state: null },
    route: {
      kind: "r2",
      objectKey: "users/test/file.bin",
      downloadUrl: "https://r2.example.test/file.bin",
      expiresAt: Date.now() + 60_000,
      probeSize: 64 * 1024,
      probeSha256: "00".repeat(32),
    },
    credentials: {
      accountId: "account",
      bucket: "bucket",
      endpoint: "https://r2.example.test",
      accessKeyId: "id",
      secretAccessKey: "secret",
      sessionToken: "token",
      objectKey: "users/test/file.bin",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

const directProbe: ProbeResult = {
  method: "direct",
  bytes: 48 * 1024,
  elapsedMs: 100,
  bytesPerSecond: 480 * 1024,
};

describe("multipath route ranking", () => {
  afterEach(() => vi.useRealTimers());

  it("ranks R2 by serial upload plus download time", () => {
    expect(rankTransferRoutes(fileSize, [directProbe], answer({ bytes: 64 * 1024, elapsedMs: 20 }), r2Session(20))[0]).toBe("r2");
    expect(rankTransferRoutes(fileSize, [directProbe], answer({ bytes: 64 * 1024, elapsedMs: 1_000 }), r2Session(1_000))[0]).toBe("direct");
  });

  it("keeps an unmeasured but prepared R2 route as the final fallback", () => {
    expect(rankTransferRoutes(fileSize, [directProbe], answer(), r2Session(20))).toEqual(["direct", "r2"]);
  });

  it("cuts off one hanging optional route without aborting the parent operation", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const operation = withRouteDeadline(parent.signal, 100, "SFU 准备", (signal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    );
    const assertion = expect(operation).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(parent.signal.aborted).toBe(false);
  });

  it("propagates parent cancellation to every child coordinator", () => {
    const parent = new AbortController();
    const child = linkedAbortController(parent.signal);
    parent.abort(new DOMException("cancelled", "AbortError"));
    expect(child.signal).toMatchObject({ aborted: true, reason: parent.signal.reason });
  });

  it("disposes a route when its connection deadline expires", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const operation = withTimeout(new Promise<never>(() => undefined), 100, dispose);
    const assertion = expect(operation).rejects.toThrow("线路连接超时");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects a winner that was not started or does not match the manifest", () => {
    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId: "123e4567-e89b-42d3-a456-426614174099",
      mode: "auto",
      createdAt: 1,
      file: {
        id: "123e4567-e89b-42d3-a456-426614174098",
        name: "demo.bin",
        size: 5,
        type: "application/octet-stream",
        lastModified: 1,
        sha256: "ab".repeat(32),
        chunkSize: 48 * 1024,
        totalChunks: 1,
      },
      routes: [],
    };
    const valid = { route: "direct" as const, bytes: 5, sha256: "ab".repeat(32) };
    expect(assertWinnerMatches(valid, offer, new Set(["direct"]))).toBe(valid);
    expect(() => assertWinnerMatches({ ...valid, route: "r2" }, offer, new Set(["direct"]))).toThrow("胜者完整性");
    expect(() => assertWinnerMatches({ ...valid, bytes: 4 }, offer, new Set(["direct"]))).toThrow("胜者完整性");
  });

  it("normalizes optional route failures without rejecting the whole preparation", async () => {
    await expect(settle(Promise.reject("route failed"))).resolves.toMatchObject({
      ok: false,
      error: { message: "route failed" },
    });
  });
});

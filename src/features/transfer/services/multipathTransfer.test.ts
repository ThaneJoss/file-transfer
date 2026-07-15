import { afterEach, describe, expect, it, vi } from "vitest";

import { fileTransferAnswerKind } from "../protocol/fileProtocol";
import type { MultipathTransferAnswer } from "../protocol/fileProtocol";
import { rankTransferRoutes, withRouteDeadline } from "./multipathTransfer";
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
});

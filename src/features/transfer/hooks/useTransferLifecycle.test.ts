import { describe, expect, it } from "vitest";

import { TransferOperationCoordinator } from "./useTransferLifecycle";

describe("TransferOperationCoordinator", () => {
  it("aborts an older operation and rejects stale completion", () => {
    const coordinator = new TransferOperationCoordinator();
    const first = coordinator.start();
    const second = coordinator.start();

    expect(first.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);

    coordinator.finish(first);
    expect(coordinator.isCurrent(second)).toBe(true);
    coordinator.finish(second);
    expect(coordinator.isCurrent(second)).toBe(false);
  });

  it("propagates cancellation through AbortSignal", () => {
    const coordinator = new TransferOperationCoordinator();
    const operation = coordinator.start();
    coordinator.cancel("用户取消。");

    expect(operation.signal.aborted).toBe(true);
    expect(operation.signal.reason).toMatchObject({ name: "AbortError", message: "用户取消。" });
  });
});

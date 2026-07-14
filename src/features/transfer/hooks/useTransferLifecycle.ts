import { useCallback, useEffect, useMemo, useRef } from "react";

export type TransferOperation = {
  id: number;
  signal: AbortSignal;
};

export class TransferOperationCoordinator {
  private active: { id: number; controller: AbortController } | null = null;
  private nextId = 1;

  start(): TransferOperation {
    this.cancel();
    const controller = new AbortController();
    const operation = { id: this.nextId, controller };
    this.nextId += 1;
    this.active = operation;
    return { id: operation.id, signal: controller.signal };
  }

  cancel(reason = "操作已取消。") {
    const active = this.active;
    this.active = null;
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(new DOMException(reason, "AbortError"));
    }
  }

  isCurrent(operation: TransferOperation) {
    return this.active?.id === operation.id && !operation.signal.aborted;
  }

  finish(operation: TransferOperation) {
    if (this.active?.id === operation.id) this.active = null;
  }
}

export function useTransferLifecycle() {
  const coordinatorRef = useRef<TransferOperationCoordinator | null>(null);
  if (!coordinatorRef.current) coordinatorRef.current = new TransferOperationCoordinator();

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    return () => coordinator?.cancel("页面已关闭。");
  }, []);

  const start = useCallback(() => coordinatorRef.current!.start(), []);
  const cancel = useCallback((reason?: string) => coordinatorRef.current!.cancel(reason), []);
  const isCurrent = useCallback(
    (operation: TransferOperation) => coordinatorRef.current!.isCurrent(operation),
    [],
  );
  const finish = useCallback(
    (operation: TransferOperation) => coordinatorRef.current!.finish(operation),
    [],
  );

  return useMemo(() => ({ start, cancel, isCurrent, finish }), [cancel, finish, isCurrent, start]);
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("操作已取消。", "AbortError");
  }
}

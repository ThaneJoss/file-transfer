import { useCallback, useState } from "react";

import type { TransferMethod, TransferMode } from "../protocol/fileProtocol";
import { runMultipathSender } from "../services/multipathTransfer";
import { cancelPickup } from "../services/pickupApi";
import { isAbortError, useTransferLifecycle } from "./useTransferLifecycle";

export type SenderPhase = "idle" | "ready" | "preparing" | "waiting" | "transferring" | "complete" | "cancelled" | "error";

export function useFileSender() {
  const lifecycle = useTransferLifecycle();
  const [file, setFileState] = useState<File | null>(null);
  const [mode, setModeState] = useState<TransferMode>("auto");
  const [phase, setPhase] = useState<SenderPhase>("idle");
  const [status, setStatus] = useState("选择一个文件后生成取件码。");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [pickupCode, setPickupCode] = useState("");
  const [pickupExpiresAt, setPickupExpiresAt] = useState<number | null>(null);
  const [winner, setWinner] = useState<TransferMethod | null>(null);

  const setFile = useCallback((nextFile: File | null) => {
    lifecycle.cancel("已选择新的文件。");
    setFileState(nextFile);
    setPhase(nextFile ? "ready" : "idle");
    setStatus(nextFile ? `已选择 ${nextFile.name}，可以生成取件码。` : "选择一个文件后生成取件码。");
    setError("");
    setProgress(0);
    setPickupCode("");
    setPickupExpiresAt(null);
    setWinner(null);
  }, [lifecycle]);

  const setMode = useCallback((nextMode: TransferMode) => {
    setModeState(nextMode);
    setStatus(nextMode === "turbo" ? "极速模式会同时使用五条线路，流量消耗更高。" : "智能模式会实测五条线路并选择预计最快的一条。");
  }, []);

  const start = useCallback(async () => {
    if (!file) {
      setError("请先选择一个文件。");
      return;
    }
    const selectedFile = file;
    const operation = lifecycle.start();
    setPhase("preparing");
    setStatus("正在准备文件和五条传输线路...");
    setError("");
    setProgress(0);
    setPickupCode("");
    setPickupExpiresAt(null);
    setWinner(null);
    let pickupWasCreated = false;
    let createdPickupCode = "";
    try {
      const result = await runMultipathSender({
        file: selectedFile,
        mode,
        signal: operation.signal,
        callbacks: {
          onStatus: (message) => {
            if (!lifecycle.isCurrent(operation)) return;
            setStatus(message);
            if (message.includes("等待接收方")) setPhase("waiting");
            else if (message.includes("传输") || message.includes("测速") || message.includes("选择")) setPhase("transferring");
          },
          onHashProgress: (bytes, total) => {
            if (!lifecycle.isCurrent(operation)) return;
            setProgress(total === 0 ? 10 : Math.min(10, bytes / total * 10));
          },
          onProgress: (bytes, total) => {
            if (!lifecycle.isCurrent(operation)) return;
            const next = total === 0 ? 100 : Math.min(100, bytes / total * 100);
            setProgress((current) => Math.max(current, next));
          },
          onPickup: (pickup) => {
            if (!lifecycle.isCurrent(operation)) return;
            pickupWasCreated = true;
            createdPickupCode = pickup.code;
            setPickupCode(pickup.code);
            setPickupExpiresAt(pickup.expiresAt);
            setPhase("waiting");
          },
        },
      });
      if (!lifecycle.isCurrent(operation)) return;
      setWinner(result.winner.route);
      setProgress(100);
      setPhase("complete");
      lifecycle.finish(operation);
    } catch (caught) {
      if (!lifecycle.isCurrent(operation) || isAbortError(caught)) return;
      if (createdPickupCode) void cancelPickup(createdPickupCode).catch(() => undefined);
      setPhase("error");
      setPickupCode("");
      setPickupExpiresAt(null);
      setError(caught instanceof AggregateError
        ? caught.errors.map((item) => item instanceof Error ? item.message : String(item)).join("；")
        : caught instanceof Error ? caught.message : "文件传输失败，请重试。");
      setStatus(pickupWasCreated ? "接收端没有完成文件校验。" : "取件码生成失败。");
      lifecycle.finish(operation);
    }
  }, [file, lifecycle, mode]);

  const cancel = useCallback(() => {
    if (pickupCode) void cancelPickup(pickupCode).catch(() => undefined);
    lifecycle.cancel("传输已取消。");
    setPhase("cancelled");
    setPickupCode("");
    setPickupExpiresAt(null);
    setStatus("传输已取消，可以重新开始。");
    setError("");
  }, [lifecycle, pickupCode]);

  const reset = useCallback(() => setFile(null), [setFile]);
  const busy = phase === "preparing" || phase === "waiting" || phase === "transferring";

  return {
    file, mode, phase, status, error, progress, pickupCode, pickupExpiresAt,
    winner, busy, setFile, setMode, start, cancel, reset,
  };
}

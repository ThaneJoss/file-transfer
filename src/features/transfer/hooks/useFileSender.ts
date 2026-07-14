import { useCallback, useState } from "react";

import { isAbortError, useTransferLifecycle } from "./useTransferLifecycle";

export type SenderPhase =
  | "idle"
  | "ready"
  | "hashing"
  | "authorizing"
  | "uploading"
  | "publishing"
  | "complete"
  | "cancelled"
  | "error";

const phaseMessage: Record<Exclude<SenderPhase, "idle" | "ready" | "complete" | "cancelled" | "error">, string> = {
  hashing: "正在校验文件完整性...",
  authorizing: "正在准备安全上传...",
  uploading: "正在上传文件...",
  publishing: "正在生成取件码...",
};

export function useFileSender() {
  const lifecycle = useTransferLifecycle();
  const [file, setFileState] = useState<File | null>(null);
  const [phase, setPhase] = useState<SenderPhase>("idle");
  const [status, setStatus] = useState("选择一个文件后开始上传。");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [pickupCode, setPickupCode] = useState("");
  const [pickupExpiresAt, setPickupExpiresAt] = useState<number | null>(null);
  const [pendingProtocol, setPendingProtocol] = useState("");

  const setFile = useCallback((nextFile: File | null) => {
    lifecycle.cancel("已选择新的文件。");
    setFileState(nextFile);
    setPhase(nextFile ? "ready" : "idle");
    setStatus(nextFile ? `已选择 ${nextFile.name}，可以开始上传。` : "选择一个文件后开始上传。");
    setError("");
    setProgress(0);
    setPickupCode("");
    setPickupExpiresAt(null);
    setPendingProtocol("");
  }, [lifecycle]);

  const upload = useCallback(async () => {
    if (!file) {
      setError("请先选择一个文件。");
      return;
    }
    const selectedFile = file;
    const operation = lifecycle.start();
    setError("");
    setPickupCode("");
    setPickupExpiresAt(null);
    setPendingProtocol("");
    setProgress(0);
    let protocolWasReady = false;

    try {
      const service = await import("../services/r2Transfer");
      if (!lifecycle.isCurrent(operation)) return;
      const result = await service.uploadFile({
        file: selectedFile,
        signal: operation.signal,
        onPhase: (nextPhase) => {
          if (!lifecycle.isCurrent(operation)) return;
          setPhase(nextPhase);
          setStatus(phaseMessage[nextPhase]);
          if (nextPhase === "authorizing") setProgress((value) => Math.max(value, 20));
          if (nextPhase === "publishing") setProgress((value) => Math.max(value, 96));
        },
        onHashProgress: (bytes, total) => {
          if (!lifecycle.isCurrent(operation)) return;
          setProgress(total === 0 ? 20 : Math.min(20, (bytes / total) * 20));
        },
        onUploadProgress: (bytes, total) => {
          if (!lifecycle.isCurrent(operation)) return;
          setProgress(total === 0 ? 95 : 20 + Math.min(75, (bytes / total) * 75));
        },
        onProtocolReady: (protocol) => {
          if (!lifecycle.isCurrent(operation)) return;
          protocolWasReady = true;
          setPendingProtocol(protocol);
        },
      });
      if (!lifecycle.isCurrent(operation)) return;
      setPendingProtocol(result.protocol);
      setPickupCode(result.pickup.code);
      setPickupExpiresAt(result.pickup.expiresAt);
      setProgress(100);
      setPhase("complete");
      setStatus("上传完成，取件码已生成。");
      lifecycle.finish(operation);
    } catch (caught) {
      if (!lifecycle.isCurrent(operation) || isAbortError(caught)) return;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "上传失败，请重试。");
      setStatus(protocolWasReady ? "文件已上传，但取件码生成失败。" : "上传没有完成。");
      lifecycle.finish(operation);
    }
  }, [file, lifecycle]);

  const retryPickup = useCallback(async () => {
    if (!pendingProtocol) return;
    const operation = lifecycle.start();
    setError("");
    setPhase("publishing");
    setStatus("正在重新生成取件码...");
    setProgress(96);
    try {
      const { publishPickup } = await import("../services/r2Transfer");
      const pickup = await publishPickup(pendingProtocol, operation.signal);
      if (!lifecycle.isCurrent(operation)) return;
      setPickupCode(pickup.code);
      setPickupExpiresAt(pickup.expiresAt);
      setProgress(100);
      setPhase("complete");
      setStatus("取件码已生成。");
      lifecycle.finish(operation);
    } catch (caught) {
      if (!lifecycle.isCurrent(operation) || isAbortError(caught)) return;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "生成取件码失败。");
      setStatus("文件已上传，但取件码生成失败。");
      lifecycle.finish(operation);
    }
  }, [lifecycle, pendingProtocol]);

  const cancel = useCallback(() => {
    lifecycle.cancel("上传已取消。");
    setPhase("cancelled");
    setStatus("上传已取消，可以重新开始。");
    setError("");
  }, [lifecycle]);

  const reset = useCallback(() => setFile(null), [setFile]);
  const busy = phase === "hashing" || phase === "authorizing" || phase === "uploading" || phase === "publishing";

  return {
    file,
    phase,
    status,
    error,
    progress,
    pickupCode,
    pickupExpiresAt,
    canRetryPickup: phase === "error" && Boolean(pendingProtocol),
    busy,
    setFile,
    upload,
    retryPickup,
    cancel,
    reset,
  };
}

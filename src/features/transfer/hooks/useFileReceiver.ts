import { useCallback, useEffect, useRef, useState } from "react";

import type { TransferFileManifest, TransferMethod, TransferMode } from "../protocol/fileProtocol";
import { chooseInitialReceiveTarget, inspectPickupFile, runMultipathReceiver } from "../services/multipathTransfer";
import type { RouteStates } from "../services/multipathTransfer";
import { cancelPickup } from "../services/pickupApi";
import type { PickupPayload } from "../services/pickupApi";
import { TransferDiagnosticSession } from "../services/transferDiagnostics";
import { isAbortError, useTransferLifecycle } from "./useTransferLifecycle";

export type ReceiverPhase = "idle" | "connecting" | "receiving" | "complete" | "cancelled" | "error";

export function useFileReceiver({ allowGuest = false, initialCode = "" }: { allowGuest?: boolean; initialCode?: string } = {}) {
  const lifecycle = useTransferLifecycle();
  const diagnosticRef = useRef<TransferDiagnosticSession | null>(null);
  const [code, setCodeState] = useState(() => initialCode.replace(/\D/g, "").slice(0, 8));
  const [descriptor, setDescriptor] = useState<TransferFileManifest | null>(null);
  const [transferMode, setTransferMode] = useState<TransferMode | "legacy" | null>(null);
  const [phase, setPhase] = useState<ReceiverPhase>("idle");
  const [status, setStatus] = useState("输入 8 位取件码后开始接收。");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [savedTo, setSavedTo] = useState("");
  const [winner, setWinner] = useState<TransferMethod | null>(null);
  const [preparedPickup, setPreparedPickup] = useState<PickupPayload | null>(null);
  const [metadataPending, setMetadataPending] = useState(false);
  const [routes, setRoutes] = useState<RouteStates>({});
  const [supportId, setSupportId] = useState("");
  const busy = phase === "connecting" || phase === "receiving";

  useEffect(() => {
    if (!/^\d{8}$/.test(code) || busy || preparedPickup) return;
    const controller = new AbortController();
    setMetadataPending(true);
    setPreparedPickup(null);
    setError("");
    setStatus("正在读取取件码中的文件信息...");
    void inspectPickupFile(code, controller.signal, () => {
      if (!controller.signal.aborted) setStatus("取件码已生成，发送端正在准备文件和线路...");
    }, allowGuest).then(({ pickup, file, mode }) => {
      if (controller.signal.aborted) return;
      setPreparedPickup(pickup);
      setDescriptor(file);
      setTransferMode(mode);
      setStatus(mode === "turbo"
        ? `将接收 ${file.name}，点击开始后会并发使用五条可用线路。`
        : `将接收 ${file.name}，点击开始后自动选择最快线路。`);
    }).catch((caught) => {
      if (isAbortError(caught)) return;
      setPreparedPickup(null);
      setDescriptor(null);
      setTransferMode(null);
      setError(caught instanceof Error ? caught.message : "无法读取这个取件码。");
      setStatus("取件码不可用。");
    }).finally(() => {
      if (!controller.signal.aborted) setMetadataPending(false);
    });
    return () => controller.abort(new DOMException("取件码已更改。", "AbortError"));
  }, [allowGuest, busy, code, preparedPickup]);

  const setCode = useCallback((value: string) => {
    lifecycle.cancel("取件码已更改。");
    const normalized = value.replace(/\D/g, "").slice(0, 8);
    setCodeState(normalized);
    setDescriptor(null);
    setTransferMode(null);
    setPhase("idle");
    setStatus(normalized ? "点击开始接收，系统会自动连接最快线路。" : "输入 8 位取件码后开始接收。");
    setError("");
    setProgress(0);
    setDownloadedBytes(0);
    setSavedTo("");
    setWinner(null);
    setPreparedPickup(null);
    setMetadataPending(false);
    setRoutes({});
    setSupportId("");
  }, [lifecycle]);

  const receive = useCallback(async () => {
    if (!/^\d{8}$/.test(code)) {
      setError("取件码必须是 8 位数字。");
      return;
    }
    if (!preparedPickup || !descriptor) {
      setError("请等待取件码中的文件信息读取完成。");
      return;
    }

    let target;
    try {
      // Keep the file picker in the original click activation before any network await.
      target = await chooseInitialReceiveTarget(descriptor);
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError(caught instanceof Error ? caught.message : "无法选择保存位置。");
      return;
    }

    const operation = lifecycle.start();
    const diagnostic = new TransferDiagnosticSession();
    diagnosticRef.current = diagnostic;
    setSupportId(diagnostic.id);
    setPhase("connecting");
    setStatus("正在读取取件码并连接发送端...");
    setError("");
    setDescriptor(null);
    setTransferMode(null);
    setProgress(0);
    setDownloadedBytes(0);
    setSavedTo("");
    setWinner(null);
    setRoutes({});
    try {
      const result = await runMultipathReceiver({
        code,
        target,
        signal: operation.signal,
        preparedPickup,
        callbacks: {
          onStatus: (message) => {
            if (!lifecycle.isCurrent(operation)) return;
            setStatus(message);
            if (message.includes("传输") || message.includes("接收") || message.includes("下载")) setPhase("receiving");
          },
          onFile: (file, mode) => {
            if (!lifecycle.isCurrent(operation)) return;
            setDescriptor(file);
            setTransferMode(mode);
          },
          onProgress: (bytes, total) => {
            if (!lifecycle.isCurrent(operation)) return;
            setDownloadedBytes(bytes);
            setProgress(total === 0 ? 100 : Math.min(100, bytes / total * 100));
          },
          onRoutes: (nextRoutes) => {
            if (!lifecycle.isCurrent(operation)) return;
            setRoutes(nextRoutes);
            diagnostic.updateRoutes(nextRoutes);
          },
        },
      });
      if (!lifecycle.isCurrent(operation)) return;
      setWinner(result.winner.route);
      setDownloadedBytes(result.winner.bytes);
      setProgress(100);
      setSavedTo(result.result.savedToDisk ? result.result.targetName : "浏览器下载");
      setPhase("complete");
      void diagnostic.flush({
        side: "receiver",
        outcome: "complete",
        mode: result.mode,
        winner: result.winner.route,
      });
      lifecycle.finish(operation);
    } catch (caught) {
      if (!lifecycle.isCurrent(operation) || isAbortError(caught)) return;
      void cancelPickup(code).catch(() => undefined);
      setCodeState("");
      setPreparedPickup(null);
      setDescriptor(null);
      setTransferMode(null);
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "接收失败，请重试。");
      setStatus("文件没有保存，请输入新的取件码。");
      void diagnostic.flush({ side: "receiver", outcome: "error", mode: transferMode, error: caught });
      lifecycle.finish(operation);
    }
  }, [code, descriptor, lifecycle, preparedPickup, transferMode]);

  const cancel = useCallback(() => {
    if (busy) void cancelPickup(code).catch(() => undefined);
    lifecycle.cancel("接收已取消。");
    setCodeState("");
    setPreparedPickup(null);
    setDescriptor(null);
    setTransferMode(null);
    setProgress(0);
    setDownloadedBytes(0);
    setPhase("cancelled");
    setStatus("接收已取消，请输入新的取件码。");
    setError("");
    void diagnosticRef.current?.flush({ side: "receiver", outcome: "cancelled", mode: transferMode });
  }, [busy, code, lifecycle, transferMode]);

  const reset = useCallback(() => setCode(""), [setCode]);

  return {
    code, descriptor, transferMode, phase, status, error, progress, downloadedBytes,
    savedTo, winner, routes, supportId, busy, metadataPending,
    readyToReceive: Boolean(preparedPickup && descriptor),
    setCode, receive, cancel, reset,
  };
}

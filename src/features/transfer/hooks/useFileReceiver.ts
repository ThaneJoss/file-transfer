import { useCallback, useRef, useState } from "react";

import type { R2TransferDescriptor } from "../protocol/fileProtocol";
import { isAbortError, useTransferLifecycle } from "./useTransferLifecycle";

type TransferRouterModule = typeof import("../services/transferRouter");

export type ReceiverPhase = "idle" | "resolving" | "ready" | "downloading" | "complete" | "cancelled" | "error";

export function useFileReceiver() {
  const lifecycle = useTransferLifecycle();
  const routerRef = useRef<TransferRouterModule | null>(null);
  const [code, setCodeState] = useState("");
  const [descriptor, setDescriptor] = useState<R2TransferDescriptor | null>(null);
  const [phase, setPhase] = useState<ReceiverPhase>("idle");
  const [status, setStatus] = useState("输入 8 位取件码读取文件信息。");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [savedTo, setSavedTo] = useState("");

  const setCode = useCallback((value: string) => {
    lifecycle.cancel("取件码已更改。");
    const normalized = value.replace(/\D/g, "").slice(0, 8);
    setCodeState(normalized);
    setDescriptor(null);
    setPhase("idle");
    setStatus(normalized ? "读取取件码后即可下载。" : "输入 8 位取件码读取文件信息。");
    setError("");
    setProgress(0);
    setDownloadedBytes(0);
    setSavedTo("");
  }, [lifecycle]);

  const resolve = useCallback(async () => {
    if (!/^\d{8}$/.test(code)) {
      setError("取件码必须是 8 位数字。");
      return;
    }
    const operation = lifecycle.start();
    setPhase("resolving");
    setStatus("正在读取取件码...");
    setError("");
    setDescriptor(null);
    setProgress(0);
    setDownloadedBytes(0);
    setSavedTo("");
    try {
      const router = await import("../services/transferRouter");
      routerRef.current = router;
      const result = await router.resolvePickupProtocol(code, operation.signal);
      if (!lifecycle.isCurrent(operation)) return;
      setDescriptor(result.descriptor);
      setPhase("ready");
      setStatus(
        result.descriptor.file.sha256
          ? "文件信息已读取，下载时会校验完整性。"
          : "文件来自旧协议，下载时只能校验文件大小。",
      );
      lifecycle.finish(operation);
    } catch (caught) {
      if (!lifecycle.isCurrent(operation) || isAbortError(caught)) return;
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "读取取件码失败。");
      setStatus("没有读取到可下载的文件。");
      lifecycle.finish(operation);
    }
  }, [code, lifecycle]);

  const download = useCallback(async () => {
    if (!descriptor) {
      setError("请先读取有效取件码。");
      return;
    }
    const router = routerRef.current;
    if (!router) {
      setError("下载模块尚未准备好，请重新读取取件码。");
      return;
    }

    const operation = lifecycle.start();
    setPhase("downloading");
    setStatus("请选择保存位置，然后开始下载...");
    setError("");
    setProgress(0);
    setDownloadedBytes(0);
    setSavedTo("");
    try {
      const target = await router.chooseReceiveTarget(descriptor);
      if (!lifecycle.isCurrent(operation)) return;
      setStatus("正在下载并校验文件...");
      const result = await router.downloadFile({
        descriptor,
        target,
        signal: operation.signal,
        onProgress: (bytes, total) => {
          if (!lifecycle.isCurrent(operation)) return;
          setDownloadedBytes(bytes);
          setProgress(total === 0 ? 100 : Math.min(100, (bytes / total) * 100));
        },
      });
      if (!lifecycle.isCurrent(operation)) return;
      setDownloadedBytes(result.bytes);
      setProgress(100);
      setSavedTo(result.savedToDisk ? result.targetName : "浏览器下载");
      setPhase("complete");
      setStatus(
        descriptor.file.sha256
          ? "下载完成，文件大小和 SHA-256 校验通过。"
          : "下载完成，文件大小校验通过。",
      );
      lifecycle.finish(operation);
    } catch (caught) {
      if (!lifecycle.isCurrent(operation)) return;
      if (isAbortError(caught)) {
        setPhase("ready");
        setStatus("未选择保存位置，可以再次下载。");
        lifecycle.finish(operation);
        return;
      }
      setPhase("error");
      setError(caught instanceof Error ? caught.message : "下载失败，请重试。");
      setStatus("文件没有保存。");
      lifecycle.finish(operation);
    }
  }, [descriptor, lifecycle]);

  const cancel = useCallback(() => {
    lifecycle.cancel("下载已取消。");
    setPhase(descriptor ? "ready" : "cancelled");
    setStatus(descriptor ? "下载已取消，可以重新开始。" : "操作已取消。");
    setError("");
  }, [descriptor, lifecycle]);

  const reset = useCallback(() => setCode(""), [setCode]);
  const busy = phase === "resolving" || phase === "downloading";

  return {
    code,
    descriptor,
    phase,
    status,
    error,
    progress,
    downloadedBytes,
    savedTo,
    busy,
    setCode,
    resolve,
    download,
    cancel,
    reset,
  };
}

import { ApiError } from "../../../lib/api/client";
import { throwIfAborted } from "../hooks/useTransferLifecycle";
import type {
  MultipathTransferAnswer,
  MultipathTransferOffer,
  TransferFileManifest,
  TransferMethod,
  TransferMode,
} from "../protocol/fileProtocol";
import { memoryReceiveLimitBytes } from "../protocol/fileStream";
import type { ReceiveTarget } from "../protocol/fileStream";
import { estimateCompletionMs } from "./channelTransfer";
import type { ProbeResult } from "./channelTransfer";
import { setPickupWinner } from "./pickupApi";
import type { R2SenderSession } from "./r2Transfer";

export const multipathChunkSize = 48 * 1024;
export const routePreparationTimeoutMs = 5_000;
export const winnerRecoveryTimeoutMs = 3_000;

export type RouteState = "preparing" | "ready" | "probing" | "selected" | "transferring" | "complete" | "failed";
export type RouteStates = Partial<Record<TransferMethod, RouteState>>;

export type CommonCallbacks = {
  onStatus?: (message: string) => void;
  onProgress?: (bytes: number, total: number) => void;
  onRoutes?: (states: RouteStates) => void;
};

export type SenderCallbacks = CommonCallbacks & {
  onHashProgress?: (bytes: number, total: number) => void;
  onPickup?: (pickup: { code: string; expiresAt: number }) => void;
};

export type ReceiverCallbacks = CommonCallbacks & {
  onFile?: (file: TransferFileManifest, mode: TransferMode | "legacy") => void;
};

export function rankTransferRoutes(
  fileSize: number,
  probes: ProbeResult[],
  answer: MultipathTransferAnswer,
  r2: R2SenderSession | null,
) {
  const scores = new Map<TransferMethod, number>();
  for (const result of probes) scores.set(result.method, estimateCompletionMs(fileSize, result));
  const r2Download = answer.metrics.r2;
  if (r2Download && r2) {
    const uploadBps = r2.route.probeSize * 1000 / r2.probeUploadElapsedMs;
    const downloadBps = r2Download.bytes * 1000 / r2Download.elapsedMs;
    scores.set(
      "r2",
      r2.probeUploadElapsedMs + fileSize / Math.max(1, uploadBps) * 1000 +
        r2Download.elapsedMs + fileSize / Math.max(1, downloadBps) * 1000,
    );
  } else if (r2) {
    scores.set("r2", Number.MAX_SAFE_INTEGER);
  }
  return [...scores.entries()].sort((left, right) => left[1] - right[1]).map(([route]) => route);
}

export function linkedAbortController(parent: AbortSignal) {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return controller;
}

export async function withRouteDeadline<T>(
  parent: AbortSignal,
  milliseconds: number,
  label: string,
  work: (signal: AbortSignal) => Promise<T>,
) {
  const controller = linkedAbortController(parent);
  const timer = globalThis.setTimeout(() => {
    controller.abort(new DOMException(`${label}超时（${milliseconds}ms）。`, "TimeoutError"));
  }, milliseconds);
  try {
    return await work(controller.signal);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function neverSettles(): Promise<never> {
  return new Promise(() => undefined);
}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number, onTimeout: () => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new Error(`线路连接超时（${milliseconds}ms）。`));
    }, milliseconds);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function assertTargetCapacity(target: ReceiveTarget, fileSize: number) {
  if (target.kind === "memory" && fileSize > memoryReceiveLimitBytes) {
    throw new Error("当前浏览器无法流式保存这个大文件，请改用最新版 Chrome 或 Edge。");
  }
}

export async function confirmPickupWinner(
  code: string,
  winner: { route: TransferMethod; bytes: number; sha256: string },
  signal: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    throwIfAborted(signal);
    try {
      await setPickupWinner(code, winner, signal);
      return true;
    } catch (error) {
      if (error instanceof ApiError && (
        error.status === 400 || error.status === 403 || error.status === 404 ||
        error.status === 409 || error.status === 410
      )) throw error;
      lastError = error;
      await coordinationDelay(300 * 2 ** attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法通知发送端传输已完成。");
}

export function coordinationDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = globalThis.setTimeout(done, milliseconds);
    const cancel = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    function done() {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function routeLabel(route: TransferMethod) {
  return ({ direct: "Direct", stun: "STUN", turn: "TURN", sfu: "SFU", r2: "R2" } as const)[route];
}

export function assertWinnerMatches<T extends { route: TransferMethod; bytes: number; sha256: string }>(
  winner: T,
  offer: MultipathTransferOffer,
  startedMethods: Set<TransferMethod>,
) {
  if (!startedMethods.has(winner.route) || winner.bytes !== offer.file.size || winner.sha256.toLowerCase() !== offer.file.sha256) {
    throw new Error("接收端返回的胜者完整性信息与当前文件不一致。");
  }
  return winner;
}

export function isRemoteCancellation(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("取消传输") || error.message.includes("cancelled")) return true;
  return error.cause instanceof ApiError && error.cause.status === 410;
}

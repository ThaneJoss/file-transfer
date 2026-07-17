import { apiJson } from "../../../lib/api/client";
import type { TransferMethod, TransferMode } from "../protocol/fileProtocol";
import type { RouteStates } from "./multipathTransfer";

export type DiagnosticOutcome = "complete" | "error" | "cancelled";

export class TransferDiagnosticSession {
  readonly id = crypto.randomUUID();
  private readonly startedAt = performance.now();
  private routes: RouteStates = {};
  private flushed = false;

  updateRoutes(routes: RouteStates) {
    this.routes = { ...routes };
  }

  flush(input: {
    side: "sender" | "receiver";
    outcome: DiagnosticOutcome;
    mode: TransferMode | "legacy" | null;
    winner?: TransferMethod | null;
    error?: unknown;
  }) {
    if (this.flushed) return Promise.resolve(false);
    this.flushed = true;
    return apiJson<{ accepted: true }>("/v1/diagnostics/transfers", "POST", {
      id: this.id,
      side: input.side,
      outcome: input.outcome,
      mode: input.mode,
      winner: input.winner ?? null,
      durationMs: Math.max(0, performance.now() - this.startedAt),
      errorCode: input.error ? classifyTransferError(input.error) : null,
      capabilities: {
        rtc: typeof RTCPeerConnection === "function",
        fileSystem: typeof window !== "undefined" && "showSaveFilePicker" in window,
        worker: typeof Worker === "function",
      },
      routes: this.routes,
    }).then(() => true).catch(() => false);
  }
}

export function classifyTransferError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (error instanceof DOMException && error.name === "AbortError") return "TRANSFER_ABORTED";
  if (message.includes("sha-256") || message.includes("完整性")) return "INTEGRITY_MISMATCH";
  if (message.includes("取件码") && message.includes("过期")) return "PICKUP_EXPIRED";
  if (message.includes("取消")) return "REMOTE_CANCELLED";
  if (message.includes("超时")) return "ROUTE_TIMEOUT";
  if (message.includes("r2")) return "R2_FAILURE";
  if (message.includes("sfu")) return "SFU_FAILURE";
  if (message.includes("turn")) return "TURN_FAILURE";
  if (message.includes("协议")) return "PROTOCOL_INVALID";
  if (message.includes("网络") || error instanceof TypeError) return "NETWORK_FAILURE";
  return "TRANSFER_FAILURE";
}

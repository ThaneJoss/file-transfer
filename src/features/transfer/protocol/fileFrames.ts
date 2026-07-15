import type { TransferMethod } from "./fileProtocol";

const frameMagic = 0x46543301;
const headerBytes = 9;

export type FileFrame = {
  kind: "data" | "probe";
  sequence: number;
  payload: Uint8Array;
};

export type TransferControlMessage =
  | { kind: "transfer-done"; transferId: string; totalChunks: number; sha256: string }
  | { kind: "transfer-complete"; transferId: string; route: TransferMethod; bytes: number; sha256: string }
  | { kind: "transfer-error"; transferId: string; message: string }
  | { kind: "probe-ack"; transferId: string; probeId: number; bytes: number }
  | { kind: "chunk-ack"; transferId: string; sequence: number };

export function encodeFileFrame(kind: FileFrame["kind"], sequence: number, payload: Uint8Array) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new Error("文件分块序号无效。");
  }
  const result = new Uint8Array(headerBytes + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, frameMagic);
  view.setUint8(4, kind === "data" ? 1 : 2);
  view.setUint32(5, sequence);
  result.set(payload, headerBytes);
  return result;
}

export function decodeFileFrame(value: ArrayBuffer | ArrayBufferView): FileFrame {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength < headerBytes) throw new Error("收到的文件分块过短。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== frameMagic) throw new Error("收到未知的数据帧。");
  const type = view.getUint8(4);
  if (type !== 1 && type !== 2) throw new Error("收到未知的数据帧类型。");
  return {
    kind: type === 1 ? "data" : "probe",
    sequence: view.getUint32(5),
    payload: bytes.slice(headerBytes),
  };
}

export function encodeControlMessage(message: TransferControlMessage) {
  return JSON.stringify(message);
}

export function decodeControlMessage(value: string): TransferControlMessage {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("收到无法识别的传输控制消息。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("收到无法识别的传输控制消息。");
  const message = parsed as Record<string, unknown>;
  if (typeof message.kind !== "string" || typeof message.transferId !== "string") throw new Error("收到无法识别的传输控制消息。");
  if (message.kind === "transfer-done") {
    if (!isCount(message.totalChunks) || !isSha256(message.sha256)) throw new Error("传输完成消息无效。");
  } else if (message.kind === "transfer-complete") {
    if (!isMethod(message.route) || !isCount(message.bytes) || !isSha256(message.sha256)) throw new Error("传输确认消息无效。");
  } else if (message.kind === "transfer-error") {
    if (typeof message.message !== "string" || !message.message || message.message.length > 500) throw new Error("传输错误消息无效。");
  } else if (message.kind === "probe-ack") {
    if (!isUint32(message.probeId) || !isCount(message.bytes)) throw new Error("测速确认消息无效。");
  } else if (message.kind === "chunk-ack") {
    if (!isUint32(message.sequence)) throw new Error("分块确认消息无效。");
  } else {
    throw new Error("收到无法识别的传输控制消息。");
  }
  return message as TransferControlMessage;
}

export async function messageDataToBuffer(data: unknown) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  if (data instanceof Blob) return data.arrayBuffer();
  throw new Error("收到不支持的二进制数据类型。");
}

function isCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isUint32(value: unknown): value is number { return isCount(value) && value <= 0xffff_ffff; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value); }
function isMethod(value: unknown): value is TransferMethod { return value === "direct" || value === "stun" || value === "turn" || value === "sfu" || value === "r2"; }

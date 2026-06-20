import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const sfuFileProtocolKind = "cloudflare-sfu-file-v2" as const;
export const memoryReceiveLimitBytes = 128 * 1024 * 1024;

const chunkMagic = new Uint8Array([0x53, 0x46, 0x55, 0x32]);
const fileIdSize = 16;
const sequenceSize = 4;
export const sfuChunkHeaderSize = chunkMagic.byteLength + fileIdSize + sequenceSize;
const preferredMessageSize = 64 * 1024;
const fallbackMessageSize = 16 * 1024;
const hashReadSize = 1024 * 1024;

export type SfuTransferFile = {
  fileId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  chunkSize: number;
  totalChunks: number;
};

export type SfuTransferMeta = SfuTransferFile & {
  kind: "meta";
  sha256: string;
};

export type SfuTransferDone = {
  kind: "done";
  fileId: string;
  totalChunks: number;
  sha256: string;
};

export type SfuFileChunk = {
  fileId: string;
  sequence: number;
  payload: Uint8Array;
};

export type ReceiveTarget =
  | { kind: "file-system"; handle: FileSystemFileHandle }
  | { kind: "memory" };

export type ReceiveSink = {
  kind: ReceiveTarget["kind"];
  name: string;
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<Blob | null>;
  abort: () => Promise<void>;
};

type SaveFilePickerOptions = {
  suggestedName?: string;
};

type WindowWithSaveFilePicker = Window & {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
};

export function getSfuChunkPayloadSize(peer: RTCPeerConnection) {
  const negotiated = peer.sctp?.maxMessageSize;
  const messageSize =
    typeof negotiated === "number" && negotiated > 0
      ? Number.isFinite(negotiated)
        ? Math.min(Math.floor(negotiated), preferredMessageSize)
        : preferredMessageSize
      : fallbackMessageSize;

  if (messageSize <= sfuChunkHeaderSize) {
    throw new Error(`SFU 协商出的单条消息上限过小：${messageSize} 字节。`);
  }
  return messageSize - sfuChunkHeaderSize;
}

export function encodeSfuFileChunk(fileId: string, sequence: number, payload: Uint8Array) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw new Error("SFU 文件分块序号无效。");
  }

  const message = new Uint8Array(sfuChunkHeaderSize + payload.byteLength);
  message.set(chunkMagic, 0);
  message.set(uuidToBytes(fileId), chunkMagic.byteLength);
  new DataView(message.buffer).setUint32(chunkMagic.byteLength + fileIdSize, sequence);
  message.set(payload, sfuChunkHeaderSize);
  return message.buffer;
}

export function decodeSfuFileChunk(value: ArrayBuffer): SfuFileChunk {
  const message = new Uint8Array(value);
  if (message.byteLength < sfuChunkHeaderSize) {
    throw new Error("收到的 SFU 文件分块缺少协议头。");
  }
  for (let index = 0; index < chunkMagic.byteLength; index += 1) {
    if (message[index] !== chunkMagic[index]) throw new Error("收到的 SFU 文件分块协议版本不正确。");
  }

  const fileIdStart = chunkMagic.byteLength;
  const fileIdEnd = fileIdStart + fileIdSize;
  return {
    fileId: bytesToUuid(message.subarray(fileIdStart, fileIdEnd)),
    sequence: new DataView(value).getUint32(fileIdEnd),
    payload: message.subarray(sfuChunkHeaderSize),
  };
}

export function createSha256Hasher() {
  const hash = sha256.create();
  return {
    update(value: Uint8Array) {
      hash.update(value);
    },
    digestHex() {
      return bytesToHex(hash.digest());
    },
  };
}

export async function sha256File(file: Blob, onProgress?: (bytes: number) => void) {
  const hash = createSha256Hasher();
  let offset = 0;
  while (offset < file.size) {
    const buffer = await file.slice(offset, offset + hashReadSize).arrayBuffer();
    hash.update(new Uint8Array(buffer));
    offset += buffer.byteLength;
    onProgress?.(offset);
  }
  return hash.digestHex();
}

export function supportsFileSystemReceive() {
  return typeof window !== "undefined" && typeof (window as WindowWithSaveFilePicker).showSaveFilePicker === "function";
}

export async function pickFileSystemReceiveTarget(suggestedName: string): Promise<ReceiveTarget> {
  const picker = (window as WindowWithSaveFilePicker).showSaveFilePicker;
  if (!picker) throw new Error("当前浏览器不支持直接流式写入文件。");
  const handle = await picker({ suggestedName });
  return { kind: "file-system", handle };
}

export async function openReceiveSink(target: ReceiveTarget, mimeType: string): Promise<ReceiveSink> {
  if (target.kind === "file-system") {
    const writable = await target.handle.createWritable();
    let closed = false;
    return {
      kind: "file-system",
      name: target.handle.name,
      async write(chunk) {
        await writable.write(chunk.slice().buffer as ArrayBuffer);
      },
      async close() {
        if (!closed) {
          closed = true;
          await writable.close();
        }
        return null;
      },
      async abort() {
        if (!closed) {
          closed = true;
          await writable.abort().catch(() => undefined);
        }
      },
    };
  }

  const chunks: ArrayBuffer[] = [];
  return {
    kind: "memory",
    name: "浏览器下载",
    async write(chunk) {
      chunks.push(chunk.slice().buffer as ArrayBuffer);
    },
    async close() {
      return new Blob(chunks, { type: mimeType || "application/octet-stream" });
    },
    async abort() {
      chunks.length = 0;
    },
  };
}

function uuidToBytes(value: string) {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("SFU 文件 ID 格式不正确。");
  return Uint8Array.from({ length: fileIdSize }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function bytesToUuid(value: Uint8Array) {
  const hex = bytesToHex(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { throwIfAborted } from "../hooks/useTransferLifecycle";

export const memoryReceiveLimitBytes = 128 * 1024 * 1024;
const hashReadSize = 4 * 1024 * 1024;

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

export async function sha256Blob(
  blob: Blob,
  options: {
    signal?: AbortSignal;
    onProgress?: (bytes: number, total: number) => void;
  } = {},
) {
  const hash = createSha256Hasher();
  let offset = 0;
  options.onProgress?.(0, blob.size);

  while (offset < blob.size) {
    throwIfAborted(options.signal);
    const buffer = await blob.slice(offset, offset + hashReadSize).arrayBuffer();
    throwIfAborted(options.signal);
    hash.update(new Uint8Array(buffer));
    offset += buffer.byteLength;
    options.onProgress?.(offset, blob.size);
  }

  throwIfAborted(options.signal);
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

export async function chooseReceiveTargetForFile(file: Pick<{ name: string; size: number }, "name" | "size">) {
  if (supportsFileSystemReceive()) return pickFileSystemReceiveTarget(file.name);
  if (file.size > memoryReceiveLimitBytes) {
    throw new Error("当前浏览器无法流式保存这个大文件。请使用最新版 Chrome 或 Edge，或接收不超过 128 MB 的文件。");
  }
  return { kind: "memory" } as ReceiveTarget;
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

export async function receiveVerifiedResponse({
  response,
  target,
  expectedSize,
  expectedSha256,
  mimeType,
  signal,
  onProgress,
}: {
  response: Response;
  target: ReceiveTarget;
  expectedSize: number;
  expectedSha256: string | null;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}) {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`文件下载失败：HTTP ${response.status}${body ? `，${body.slice(0, 180)}` : ""}`);
  }
  if (!response.body) throw new Error("浏览器没有提供可读取的下载数据流。");

  const sink = await openReceiveSink(target, mimeType);
  const reader = response.body.getReader();
  const hasher = createSha256Hasher();
  let receivedBytes = 0;
  onProgress?.(0, expectedSize);

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      throwIfAborted(signal);
      receivedBytes += value.byteLength;
      if (receivedBytes > expectedSize) {
        throw new Error(`收到的数据超过协议声明大小：${receivedBytes} > ${expectedSize}。`);
      }
      hasher.update(value);
      await sink.write(value);
      onProgress?.(receivedBytes, expectedSize);
    }

    if (receivedBytes !== expectedSize) {
      throw new Error(`文件不完整：协议声明 ${expectedSize} 字节，实际收到 ${receivedBytes} 字节。`);
    }
    const sha256Hex = hasher.digestHex();
    if (expectedSha256 && sha256Hex !== expectedSha256.toLowerCase()) {
      throw new Error("文件完整性校验失败：SHA-256 不一致。");
    }

    throwIfAborted(signal);
    const blob = await sink.close();
    onProgress?.(receivedBytes, expectedSize);
    return {
      blob,
      bytes: receivedBytes,
      sha256: sha256Hex,
      savedToDisk: sink.kind === "file-system",
      targetName: sink.name,
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await sink.abort();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

import { decodeConnectionPayload, encodeConnectionPayload } from "./connectionCode";

export const fileTransferProtocolKind = "file-transfer-v2" as const;
export const r2RouteKind = "r2" as const;

export type TransferFileManifest = {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sha256: string | null;
};

export type R2TransferDescriptor = {
  kind: typeof fileTransferProtocolKind;
  createdAt: number;
  file: TransferFileManifest;
  route: {
    kind: typeof r2RouteKind;
    objectKey: string;
    downloadUrl: string;
    expiresAt: number;
  };
};

type LegacyR2Descriptor = {
  kind: "cloudflare-r2-file-v1";
  objectKey: string;
  presignedUrl: string;
  expiresAt: number;
  file: {
    name: string;
    size: number;
    type?: string;
    lastModified?: number;
  };
};

export async function encodeTransferDescriptor(descriptor: R2TransferDescriptor) {
  assertR2TransferDescriptor(descriptor);
  return encodeConnectionPayload(descriptor);
}

export async function decodeTransferDescriptor(value: string): Promise<R2TransferDescriptor> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("传输协议内容为空。");
  const json = await decodeConnectionPayload(
    trimmed,
    "当前浏览器不能读取压缩传输协议，请使用最新版 Chrome、Edge 或 Safari。",
  );
  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch {
    throw protocolError();
  }

  if (isRecord(payload) && payload.kind === "cloudflare-r2-file-v1") {
    return normalizeLegacyR2Descriptor(payload as unknown as LegacyR2Descriptor);
  }

  assertR2TransferDescriptor(payload);
  return payload;
}

export function createR2TransferDescriptor({
  file,
  sha256,
  objectKey,
  downloadUrl,
  expiresAt,
}: {
  file: File;
  sha256: string;
  objectKey: string;
  downloadUrl: string;
  expiresAt: number;
}): R2TransferDescriptor {
  const descriptor: R2TransferDescriptor = {
    kind: fileTransferProtocolKind,
    createdAt: Date.now(),
    file: {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      sha256,
    },
    route: {
      kind: r2RouteKind,
      objectKey,
      downloadUrl,
      expiresAt,
    },
  };
  assertR2TransferDescriptor(descriptor);
  return descriptor;
}

export function assertR2TransferDescriptor(value: unknown): asserts value is R2TransferDescriptor {
  if (!isRecord(value) || value.kind !== fileTransferProtocolKind) throw protocolError();
  const file = value.file;
  const route = value.route;
  if (!isRecord(file) || !isRecord(route)) throw protocolError();
  if (
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0 ||
    typeof file.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(file.id) ||
    typeof file.name !== "string" ||
    !file.name.trim() ||
    file.name.length > 255 ||
    hasUnsafeFileName(file.name) ||
    typeof file.size !== "number" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    typeof file.type !== "string" ||
    file.type.length > 255 ||
    typeof file.lastModified !== "number" ||
    !Number.isSafeInteger(file.lastModified) ||
    file.lastModified < 0 ||
    typeof file.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(file.sha256) ||
    route.kind !== r2RouteKind ||
    typeof route.objectKey !== "string" ||
    !route.objectKey ||
    route.objectKey.length > 1024 ||
    route.objectKey.includes("\0") ||
    typeof route.downloadUrl !== "string" ||
    route.downloadUrl.length > 8192 ||
    typeof route.expiresAt !== "number" ||
    !Number.isSafeInteger(route.expiresAt) ||
    route.expiresAt <= 0
  ) {
    throw protocolError();
  }
  assertHttpsUrl(route.downloadUrl);
}

function normalizeLegacyR2Descriptor(value: LegacyR2Descriptor): R2TransferDescriptor {
  if (
    !value.objectKey ||
    !value.presignedUrl ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0 ||
    !value.file ||
    !value.file.name ||
    value.file.name.length > 255 ||
    hasUnsafeFileName(value.file.name) ||
    !Number.isSafeInteger(value.file.size) ||
    value.file.size < 0 ||
    (value.file.type !== undefined && (typeof value.file.type !== "string" || value.file.type.length > 255)) ||
    (value.file.lastModified !== undefined && (!Number.isSafeInteger(value.file.lastModified) || value.file.lastModified < 0)) ||
    value.objectKey.length > 1024 ||
    value.objectKey.includes("\0") ||
    value.presignedUrl.length > 8192
  ) {
    throw protocolError();
  }
  assertHttpsUrl(value.presignedUrl);
  return {
    kind: fileTransferProtocolKind,
    createdAt: Date.now(),
    file: {
      id: crypto.randomUUID(),
      name: value.file.name,
      size: value.file.size,
      type: value.file.type ?? "",
      lastModified: value.file.lastModified ?? 0,
      sha256: null,
    },
    route: {
      kind: r2RouteKind,
      objectKey: value.objectKey,
      downloadUrl: value.presignedUrl,
      expiresAt: value.expiresAt,
    },
  };
}

function assertHttpsUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError();
  }
  if (url.protocol !== "https:" || url.username || url.password) throw protocolError();
}

function hasUnsafeFileName(value: string) {
  return /[\u0000-\u001f\u007f/\\]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function protocolError() {
  return new Error("文件传输协议格式不正确。");
}

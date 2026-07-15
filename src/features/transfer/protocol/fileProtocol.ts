import { decodeConnectionPayload, encodeConnectionPayload } from "./connectionCode";

export const fileTransferProtocolKind = "file-transfer-v3" as const;
export const fileTransferAnswerKind = "file-transfer-answer-v3" as const;
export const legacyFileTransferProtocolKind = "file-transfer-v2" as const;
export const r2RouteKind = "r2" as const;

export const transferMethods = ["direct", "stun", "turn", "sfu", "r2"] as const;
export type TransferMethod = (typeof transferMethods)[number];
export type TransferMode = "auto" | "turbo";

export type TransferFileManifest = {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  sha256: string | null;
  chunkSize?: number;
  totalChunks?: number;
};

export type WebRtcRouteSignal = {
  description: RTCSessionDescriptionInit;
  candidates: RTCIceCandidateInit[];
};

export type WebRtcRouteOffer = {
  kind: "direct" | "stun" | "turn";
  signal: WebRtcRouteSignal;
};

export type SfuRouteOffer = {
  kind: "sfu";
  descriptor: Record<string, unknown>;
};

export type R2RouteOffer = {
  kind: "r2";
  objectKey: string;
  downloadUrl: string;
  expiresAt: number;
  probeSize: number;
  probeSha256: string;
};

export type TransferRouteOffer = WebRtcRouteOffer | SfuRouteOffer | R2RouteOffer;

export type MultipathTransferOffer = {
  kind: typeof fileTransferProtocolKind;
  transferId: string;
  mode: TransferMode;
  createdAt: number;
  file: TransferFileManifest & { sha256: string; chunkSize: number; totalChunks: number };
  routes: TransferRouteOffer[];
};

export type WebRtcRouteAnswer = {
  kind: "direct" | "stun" | "turn";
  signal: WebRtcRouteSignal;
};

export type SfuRouteAnswer = {
  kind: "sfu";
  descriptor: Record<string, unknown>;
};

export type TransferRouteAnswer = WebRtcRouteAnswer | SfuRouteAnswer;

export type MultipathTransferAnswer = {
  kind: typeof fileTransferAnswerKind;
  transferId: string;
  routes: TransferRouteAnswer[];
  metrics: {
    r2?: { bytes: number; elapsedMs: number };
  };
};

export type R2TransferDescriptor = {
  kind: typeof legacyFileTransferProtocolKind;
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
  file: { name: string; size: number; type?: string; lastModified?: number };
};

export async function encodeTransferOffer(offer: MultipathTransferOffer) {
  assertMultipathTransferOffer(offer);
  return encodeConnectionPayload(offer);
}

export async function decodeTransferOffer(value: string): Promise<MultipathTransferOffer> {
  const payload = await decodePayload(value);
  assertMultipathTransferOffer(payload);
  return payload;
}

export async function encodeTransferAnswer(answer: MultipathTransferAnswer) {
  assertMultipathTransferAnswer(answer);
  return encodeConnectionPayload(answer);
}

export async function decodeTransferAnswer(value: string): Promise<MultipathTransferAnswer> {
  const payload = await decodePayload(value);
  assertMultipathTransferAnswer(payload);
  return payload;
}

/** Backwards-compatible encoder for already-issued R2-only descriptors. */
export async function encodeTransferDescriptor(descriptor: R2TransferDescriptor) {
  assertR2TransferDescriptor(descriptor);
  return encodeConnectionPayload(descriptor);
}

/** Backwards-compatible decoder for v2 and the original Cloudflare R2 payload. */
export async function decodeTransferDescriptor(value: string): Promise<R2TransferDescriptor> {
  const payload = await decodePayload(value);
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
    kind: legacyFileTransferProtocolKind,
    createdAt: Date.now(),
    file: {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      sha256,
    },
    route: { kind: r2RouteKind, objectKey, downloadUrl, expiresAt },
  };
  assertR2TransferDescriptor(descriptor);
  return descriptor;
}

export function assertMultipathTransferOffer(value: unknown): asserts value is MultipathTransferOffer {
  if (!isRecord(value) || value.kind !== fileTransferProtocolKind) throw protocolError();
  if (
    !isUuid(value.transferId) ||
    (value.mode !== "auto" && value.mode !== "turbo") ||
    !isPositiveSafeInteger(value.createdAt) ||
    !isRecord(value.file) ||
    !Array.isArray(value.routes)
  ) throw protocolError();

  assertFileManifest(value.file, true);
  if (value.routes.length < 1 || value.routes.length > transferMethods.length) throw protocolError();
  const seen = new Set<string>();
  for (const route of value.routes) {
    if (!isRecord(route) || typeof route.kind !== "string" || seen.has(route.kind)) throw protocolError();
    seen.add(route.kind);
    if (route.kind === "direct" || route.kind === "stun" || route.kind === "turn") {
      assertWebRtcSignal(route.signal);
    } else if (route.kind === "sfu") {
      if (!isRecord(route.descriptor) || encodedLength(route.descriptor) > 64_000) throw protocolError();
    } else if (route.kind === "r2") {
      assertR2Route(route);
    } else {
      throw protocolError();
    }
  }
}

export function assertMultipathTransferAnswer(value: unknown): asserts value is MultipathTransferAnswer {
  if (
    !isRecord(value) ||
    value.kind !== fileTransferAnswerKind ||
    !isUuid(value.transferId) ||
    !Array.isArray(value.routes) ||
    !isRecord(value.metrics)
  ) throw protocolError();
  const seen = new Set<string>();
  for (const route of value.routes) {
    if (!isRecord(route) || typeof route.kind !== "string") throw protocolError();
    if (seen.has(route.kind)) throw protocolError();
    seen.add(route.kind);
    if (route.kind === "direct" || route.kind === "stun" || route.kind === "turn") {
      assertWebRtcSignal(route.signal);
    } else if (route.kind === "sfu") {
      if (!isRecord(route.descriptor) || encodedLength(route.descriptor) > 64_000) throw protocolError();
    } else {
      throw protocolError();
    }
  }
  const r2 = value.metrics.r2;
  if (r2 !== undefined && (!isRecord(r2) || !isNonNegativeSafeInteger(r2.bytes) || !isFinitePositive(r2.elapsedMs))) {
    throw protocolError();
  }
}

export function assertR2TransferDescriptor(value: unknown): asserts value is R2TransferDescriptor {
  if (!isRecord(value) || value.kind !== legacyFileTransferProtocolKind) throw protocolError();
  const file = value.file;
  const route = value.route;
  if (!isRecord(file) || !isRecord(route) || !isPositiveSafeInteger(value.createdAt)) throw protocolError();
  assertFileManifest(file, false);
  if (route.kind !== r2RouteKind) throw protocolError();
  assertR2Route({ ...route, probeSize: 0, probeSha256: "0".repeat(64) });
}

function assertFileManifest(file: Record<string, unknown>, multipath: boolean) {
  if (
    !isUuid(file.id) ||
    typeof file.name !== "string" ||
    !file.name.trim() ||
    file.name.length > 255 ||
    hasUnsafeFileName(file.name) ||
    !isNonNegativeSafeInteger(file.size) ||
    typeof file.type !== "string" ||
    file.type.length > 255 ||
    !isNonNegativeSafeInteger(file.lastModified) ||
    (file.sha256 !== null && (typeof file.sha256 !== "string" || !isSha256(file.sha256)))
  ) throw protocolError();

  if (multipath) {
    if (!isSha256(file.sha256) || !isPositiveSafeInteger(file.chunkSize) || (file.chunkSize as number) > 1024 * 1024) {
      throw protocolError();
    }
    const totalChunks = file.size === 0 ? 0 : Math.ceil((file.size as number) / (file.chunkSize as number));
    if (file.totalChunks !== totalChunks || totalChunks > 0x1_0000_0000) throw protocolError();
  }
}

function assertWebRtcSignal(value: unknown): asserts value is WebRtcRouteSignal {
  if (!isRecord(value) || !isRecord(value.description) || !Array.isArray(value.candidates)) throw protocolError();
  const description = value.description;
  if ((description.type !== "offer" && description.type !== "answer") || typeof description.sdp !== "string" || description.sdp.length > 96_000) {
    throw protocolError();
  }
  if (value.candidates.length > 128) throw protocolError();
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || typeof candidate.candidate !== "string" || candidate.candidate.length > 4096) {
      throw protocolError();
    }
  }
}

function assertR2Route(route: Record<string, unknown>) {
  if (
    typeof route.objectKey !== "string" || !route.objectKey || route.objectKey.length > 1024 || route.objectKey.includes("\0") ||
    typeof route.downloadUrl !== "string" || route.downloadUrl.length > 8192 ||
    !isPositiveSafeInteger(route.expiresAt) ||
    !isNonNegativeSafeInteger(route.probeSize) || (route.probeSize as number) > 1024 * 1024 ||
    !isSha256(route.probeSha256)
  ) throw protocolError();
  assertHttpsUrl(route.downloadUrl);
}

function normalizeLegacyR2Descriptor(value: LegacyR2Descriptor): R2TransferDescriptor {
  if (
    !value.objectKey || !value.presignedUrl || !isPositiveSafeInteger(value.expiresAt) || !value.file ||
    !value.file.name || value.file.name.length > 255 || hasUnsafeFileName(value.file.name) ||
    !isNonNegativeSafeInteger(value.file.size) ||
    (value.file.type !== undefined && (typeof value.file.type !== "string" || value.file.type.length > 255)) ||
    (value.file.lastModified !== undefined && !isNonNegativeSafeInteger(value.file.lastModified)) ||
    value.objectKey.length > 1024 || value.objectKey.includes("\0") || value.presignedUrl.length > 8192
  ) throw protocolError();
  assertHttpsUrl(value.presignedUrl);
  return {
    kind: legacyFileTransferProtocolKind,
    createdAt: Date.now(),
    file: {
      id: crypto.randomUUID(), name: value.file.name, size: value.file.size,
      type: value.file.type ?? "", lastModified: value.file.lastModified ?? 0, sha256: null,
    },
    route: { kind: r2RouteKind, objectKey: value.objectKey, downloadUrl: value.presignedUrl, expiresAt: value.expiresAt },
  };
}

async function decodePayload(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("传输协议内容为空。");
  const json = await decodeConnectionPayload(trimmed, "当前浏览器不能读取压缩传输协议，请使用最新版 Chrome、Edge 或 Safari。");
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw protocolError();
  }
}

function assertHttpsUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw protocolError(); }
  if (url.protocol !== "https:" || url.username || url.password) throw protocolError();
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value); }
function isNonNegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isPositiveSafeInteger(value: unknown): value is number { return isNonNegativeSafeInteger(value) && value > 0; }
function isFinitePositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function encodedLength(value: unknown) { try { return JSON.stringify(value).length; } catch { return Number.POSITIVE_INFINITY; } }
function hasUnsafeFileName(value: string) { return /[\u0000-\u001f\u007f/\\]/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function protocolError() { return new Error("文件传输协议格式不正确。"); }

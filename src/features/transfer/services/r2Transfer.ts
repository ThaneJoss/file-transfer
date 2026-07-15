import { requestR2Credentials } from "../../r2/services/r2Credentials";
import type { R2TemporaryCredentials } from "../../r2/services/r2Credentials";
import { presignedR2Url, signedR2Request } from "../../r2/services/r2Signing";
import { createR2TransferDescriptor, encodeTransferDescriptor } from "../protocol/fileProtocol";
import type { R2RouteOffer } from "../protocol/fileProtocol";
import { createSha256Hasher, receiveVerifiedResponse, sha256Blob } from "../protocol/fileStream";
import type { ReceiveTarget } from "../protocol/fileStream";
import { createPickup } from "./pickupApi";
import { reportVerifiedTransferUsage } from "./transferUsage";
import { throwIfAborted } from "../hooks/useTransferLifecycle";

export type UploadPhase = "hashing" | "authorizing" | "uploading" | "publishing";

export type R2SenderSession = {
  route: R2RouteOffer;
  credentials: R2TemporaryCredentials;
  probeUploadElapsedMs: number;
};

const r2ProbeBytes = 64 * 1024;

export async function prepareR2Route({
  file,
  signal,
  onProgress,
}: {
  file: File;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<R2SenderSession> {
  onProgress?.("正在准备 R2 线路...");
  const credentials = await requestR2Credentials(file.name, signal);
  const expiresAt = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("R2 临时授权已过期，请重试。");

  const probe = new Uint8Array(Math.min(r2ProbeBytes, Math.max(1, file.size || 1)));
  crypto.getRandomValues(probe);
  const probeSha256 = await hashBytes(probe);
  const signedProbe = await signedR2Request({
    credentials,
    method: "PUT",
    objectKey: credentials.objectKey,
    payloadHash: probeSha256,
    contentType: "application/octet-stream",
    body: probe,
  });
  const probeStartedAt = performance.now();
  await uploadSignedRequest(signedProbe.request, new Blob([probe]), signal);
  const probeUploadElapsedMs = Math.max(1, performance.now() - probeStartedAt);

  const expiresIn = Math.min(3600, Math.floor((expiresAt - Date.now()) / 1000));
  if (expiresIn < 30) throw new Error("R2 临时授权有效期不足，请重试。");
  const downloadUrl = await presignedR2Url({ credentials, method: "GET", objectKey: credentials.objectKey, expiresIn });
  return {
    credentials,
    probeUploadElapsedMs,
    route: {
      kind: "r2",
      objectKey: credentials.objectKey,
      downloadUrl,
      expiresAt,
      probeSize: probe.byteLength,
      probeSha256,
    },
  };
}

export async function benchmarkR2Route(route: R2RouteOffer, signal: AbortSignal) {
  const startedAt = performance.now();
  const response = await fetch(route.downloadUrl, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`R2 测速失败：HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  throwIfAborted(signal);
  if (bytes.byteLength !== route.probeSize || await hashBytes(bytes) !== route.probeSha256) {
    throw new Error("R2 测速对象校验失败。");
  }
  return { bytes: bytes.byteLength, elapsedMs: Math.max(1, performance.now() - startedAt) };
}

export async function uploadR2File({
  session,
  file,
  sha256,
  signal,
  onProgress,
}: {
  session: R2SenderSession;
  file: File;
  sha256: string;
  signal: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}) {
  const signed = await signedR2Request({
    credentials: session.credentials,
    method: "PUT",
    objectKey: session.route.objectKey,
    payloadHash: sha256,
    contentType: file.type || "application/octet-stream",
    body: file,
  });
  await uploadSignedRequest(signed.request, file, signal, onProgress);
}

export async function receiveR2FileWhenReady({
  route,
  target,
  expectedSize,
  expectedSha256,
  mimeType,
  signal,
  onProgress,
}: {
  route: R2RouteOffer;
  target: ReceiveTarget;
  expectedSize: number;
  expectedSha256: string;
  mimeType: string;
  signal: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}) {
  const response = await waitForR2Response(route, expectedSize, expectedSha256, signal);
  return receiveVerifiedResponse({ response, target, expectedSize, expectedSha256, mimeType, signal, onProgress });
}

export async function streamR2FileWhenReady({
  route,
  expectedSize,
  expectedSha256,
  chunkSize,
  signal,
  onChunk,
}: {
  route: R2RouteOffer;
  expectedSize: number;
  expectedSha256: string;
  chunkSize: number;
  signal: AbortSignal;
  onChunk: (sequence: number, chunk: Uint8Array) => Promise<void>;
}) {
  const response = await waitForR2Response(route, expectedSize, expectedSha256, signal);
  if (!response.body) throw new Error("浏览器没有提供可读取的 R2 数据流。");
  const reader = response.body.getReader();
  let sequence = 0;
  let bytes = 0;
  let pending = new Uint8Array(chunkSize);
  let pendingBytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      bytes += value.byteLength;
      if (bytes > expectedSize) throw new Error("R2 文件超过协议声明大小。");
      while (offset < value.byteLength) {
        const copied = Math.min(chunkSize - pendingBytes, value.byteLength - offset);
        pending.set(value.subarray(offset, offset + copied), pendingBytes);
        pendingBytes += copied;
        offset += copied;
        if (pendingBytes === chunkSize) {
          await onChunk(sequence, pending);
          sequence += 1;
          pending = new Uint8Array(chunkSize);
          pendingBytes = 0;
        }
      }
    }
    if (pendingBytes > 0) {
      await onChunk(sequence, pending.slice(0, pendingBytes));
      sequence += 1;
    }
    if (bytes !== expectedSize) throw new Error(`R2 文件不完整：应为 ${expectedSize} 字节，实际 ${bytes} 字节。`);
    return { bytes, totalChunks: sequence };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function waitForR2Response(
  route: R2RouteOffer,
  expectedSize: number,
  expectedSha256: string,
  signal: AbortSignal,
) {
  while (true) {
    throwIfAborted(signal);
    if (Date.now() >= route.expiresAt) {
      throw new Error("R2 下载授权已过期，请让发送方重新生成取件码。");
    }
    let response: Response;
    try {
      response = await fetch(route.downloadUrl, { cache: "no-store", signal });
    } catch {
      throwIfAborted(signal);
      await delay(650, signal);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403 || Date.now() >= route.expiresAt) {
        throw new Error(`R2 下载授权不可用：HTTP ${response.status}`);
      }
      await delay(650, signal);
      continue;
    }
    const lengthHeader = response.headers.get("content-length");
    const length = lengthHeader === null ? null : Number(lengthHeader);
    if (length !== null && length !== expectedSize) {
      await response.body?.cancel().catch(() => undefined);
      await delay(650, signal);
      continue;
    }
    if (expectedSize <= r2ProbeBytes) {
      const bytes = await readSmallResponse(response, r2ProbeBytes + 1);
      if (bytes.byteLength !== expectedSize || await hashBytes(bytes) !== expectedSha256) {
        await delay(650, signal);
        continue;
      }
      return new Response(bytes, { status: 200 });
    }
    if (length === null) {
      const peeked = await peekResponse(response, route.probeSize + 1, signal);
      if (peeked.complete) {
        await delay(650, signal);
        continue;
      }
      return restorePeekedResponse(peeked);
    }
    return response;
  }
}

async function readSmallResponse(response: Response, limit: number) {
  if (!response.body) throw new Error("浏览器没有提供可读取的 R2 数据流。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return new Uint8Array(0);
      }
      chunks.push(value);
    }
    return joinChunks(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

async function peekResponse(response: Response, minimumBytes: number, signal: AbortSignal) {
  if (!response.body) throw new Error("浏览器没有提供可读取的 R2 数据流。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < minimumBytes) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        return { complete: true as const, chunks, total };
      }
      chunks.push(value);
      total += value.byteLength;
    }
    return { complete: false as const, chunks, total, reader };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
}

function restorePeekedResponse(peeked: Awaited<ReturnType<typeof peekResponse>> & { complete: false }) {
  const { chunks, reader } = peeked;
  let prefixIndex = 0;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < chunks.length) {
        controller.enqueue(chunks[prefixIndex]);
        prefixIndex += 1;
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (released) return;
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
  return new Response(stream, { status: 200 });
}

function joinChunks(chunks: Uint8Array[], total: number) {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function uploadFile({
  file,
  signal,
  onPhase,
  onHashProgress,
  onUploadProgress,
  onProtocolReady,
}: {
  file: File;
  signal: AbortSignal;
  onPhase?: (phase: UploadPhase) => void;
  onHashProgress?: (bytes: number, total: number) => void;
  onUploadProgress?: (bytes: number, total: number) => void;
  onProtocolReady?: (protocol: string) => void;
}) {
  const usageTransferId = crypto.randomUUID();
  onPhase?.("hashing");
  const sha256 = await sha256Blob(file, { signal, onProgress: onHashProgress });

  onPhase?.("authorizing");
  const credentials = await requestR2Credentials(file.name, signal);
  const credentialExpiresAt = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(credentialExpiresAt) || credentialExpiresAt <= Date.now()) {
    throw new Error("临时上传授权已过期，请重试。");
  }

  const signed = await signedR2Request({
    credentials,
    method: "PUT",
    objectKey: credentials.objectKey,
    payloadHash: sha256,
    contentType: file.type || "application/octet-stream",
    body: file,
  });

  onPhase?.("uploading");
  await uploadSignedRequest(signed.request, file, signal, onUploadProgress);
  await reportVerifiedTransferUsage({ service: "r2", bytes: file.size, transferId: usageTransferId });

  onPhase?.("publishing");
  const expiresIn = Math.min(3600, Math.floor((credentialExpiresAt - Date.now()) / 1000));
  if (expiresIn < 30) {
    throw new Error("上传完成时临时授权即将过期，请重新上传以生成可用取件码。");
  }
  const downloadUrl = await presignedR2Url({
    credentials,
    method: "GET",
    objectKey: credentials.objectKey,
    expiresIn,
  });
  const descriptor = createR2TransferDescriptor({
    file,
    sha256,
    objectKey: credentials.objectKey,
    downloadUrl,
    expiresAt: credentialExpiresAt,
  });
  const protocol = await encodeTransferDescriptor(descriptor);
  onProtocolReady?.(protocol);
  const pickup = await publishPickup(protocol, signal);

  return { descriptor, protocol, pickup };
}

export async function publishPickup(protocol: string, signal?: AbortSignal) {
  return createPickup(protocol, signal, "r2");
}

export function uploadSignedRequest(
  request: Request,
  file: Blob,
  signal: AbortSignal,
  onProgress?: (bytes: number, total: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("上传已取消。", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      xhr.onload = null;
      xhr.onerror = null;
      xhr.onabort = null;
      xhr.upload.onprogress = null;
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => xhr.abort();

    xhr.open(request.method, request.url, true);
    request.headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => onProgress?.(event.loaded, file.size);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(file.size, file.size);
        finish();
        return;
      }
      const detail = typeof xhr.responseText === "string" ? xhr.responseText.slice(0, 180) : "";
      finish(new Error(`文件上传失败：HTTP ${xhr.status}${detail ? `，${detail}` : ""}`));
    };
    xhr.onerror = () => finish(new Error("文件上传网络中断，请检查网络后重试。"));
    xhr.onabort = () => finish(new DOMException("上传已取消。", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    onProgress?.(0, file.size);
    try {
      xhr.send(file);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("文件上传启动失败。"));
    }
  });
}

async function hashBytes(bytes: Uint8Array) {
  const hasher = createSha256Hasher();
  hasher.update(bytes);
  return hasher.digestHex();
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timeout = window.setTimeout(done, milliseconds);
    const cancel = () => { window.clearTimeout(timeout); signal.removeEventListener("abort", cancel); reject(signal.reason); };
    function done() { signal.removeEventListener("abort", cancel); resolve(); }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

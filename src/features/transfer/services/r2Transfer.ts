import { requestR2Credentials } from "../../r2/services/r2Credentials";
import { presignedR2Url, signedR2Request } from "../../r2/services/r2Signing";
import { createR2TransferDescriptor, encodeTransferDescriptor } from "../protocol/fileProtocol";
import { sha256Blob } from "../protocol/fileStream";
import { createPickup } from "./pickupApi";

export type UploadPhase = "hashing" | "authorizing" | "uploading" | "publishing";

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
  onPhase?.("hashing");
  const sha256 = await sha256Blob(file, { signal, onProgress: onHashProgress });

  onPhase?.("authorizing");
  const credentials = await requestR2Credentials(file.name, file.size, signal);
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
  return createPickup(protocol, signal);
}

export function uploadSignedRequest(
  request: Request,
  file: File,
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

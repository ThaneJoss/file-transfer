import { saveBlob } from "../../../lib/browser/download";
import { decodeTransferDescriptor } from "../protocol/fileProtocol";
import type { R2TransferDescriptor } from "../protocol/fileProtocol";
import {
  chooseReceiveTargetForFile,
  receiveVerifiedResponse,
} from "../protocol/fileStream";
import type { ReceiveTarget } from "../protocol/fileStream";
import { getPickup } from "./pickupApi";

export async function resolvePickupProtocol(code: string, signal?: AbortSignal) {
  const pickup = await getPickup(code, signal);
  if (Date.now() >= pickup.expiresAt) {
    throw new Error("这个取件码已经过期，请让发送方重新上传。");
  }
  if (pickup.variant !== "r2") {
    throw new Error("这个取件码来自旧版实时传输，请让发送方使用新版页面重新上传文件。");
  }
  const descriptor = await decodeTransferDescriptor(pickup.offer);
  return { descriptor, expiresAt: pickup.expiresAt };
}

export async function chooseReceiveTarget(descriptor: R2TransferDescriptor): Promise<ReceiveTarget> {
  return chooseReceiveTargetForFile(descriptor.file);
}

export async function downloadFile({
  descriptor,
  target,
  signal,
  onProgress,
}: {
  descriptor: R2TransferDescriptor;
  target: ReceiveTarget;
  signal: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}) {
  if (Date.now() >= descriptor.route.expiresAt) {
    throw new Error("这个取件码的下载链接已经过期，请让发送方重新上传。");
  }

  const response = await fetch(descriptor.route.downloadUrl, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const result = await receiveVerifiedResponse({
    response,
    target,
    expectedSize: descriptor.file.size,
    expectedSha256: descriptor.file.sha256,
    mimeType: descriptor.file.type,
    signal,
    onProgress,
  });

  if (result.blob) {
    const url = URL.createObjectURL(result.blob);
    saveBlob({ name: descriptor.file.name, url });
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return result;
}

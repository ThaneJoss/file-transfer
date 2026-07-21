import type { R2TemporaryCredentials } from "../../r2/services/r2Credentials";
import { throwIfAborted } from "../hooks/useTransferLifecycle";

const resumePrefix = "file-transfer:r2-multipart:";
const minimumPartBytes = 8 * 1024 * 1024;
const maxParts = 10_000;

export type MultipartResumeState = {
  version: 1;
  fingerprint: string;
  objectKey: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  updatedAt: number;
};

export async function loadMultipartResume(file: File) {
  const fingerprint = await fileFingerprint(file);
  const storage = localResumeStorage();
  if (!storage) return { fingerprint, state: null };
  try {
    const parsed = JSON.parse(storage.getItem(resumePrefix + fingerprint) ?? "null") as MultipartResumeState | null;
    if (isValidResumeState(parsed, fingerprint)) return { fingerprint, state: parsed };
  } catch {
    // A malformed local resume record is equivalent to no record.
  }
  storage.removeItem(resumePrefix + fingerprint);
  return { fingerprint, state: null };
}

export async function uploadMultipartR2({
  credentials,
  file,
  chunkSize,
  resume,
  signal,
  onProgress,
  allowRestart = true,
}: {
  credentials: R2TemporaryCredentials;
  file: File;
  chunkSize: number;
  resume: { fingerprint: string; state: MultipartResumeState | null };
  signal: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
  allowRestart?: boolean;
}) {
  let state = resume.state;
  try {
    if (state && state.objectKey !== credentials.objectKey) {
      clearState(state.fingerprint);
      state = null;
    }
    if (!state) {
      state = {
        version: 1,
        fingerprint: resume.fingerprint,
        objectKey: credentials.objectKey,
        uploadId: await createMultipartUpload(credentials, file.type, signal),
        parts: [],
        updatedAt: Date.now(),
      };
      saveState(state);
    }

    const partPlaintextSize = alignedPartSize(file.size, chunkSize);
    const partCount = Math.max(1, Math.ceil(file.size / partPlaintextSize));
    const completed = new Map(state.parts.map((part) => [part.partNumber, part.etag]));
    onProgress?.(0, file.size);

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      throwIfAborted(signal);
      const start = (partNumber - 1) * partPlaintextSize;
      const end = Math.min(file.size, start + partPlaintextSize);
      if (completed.has(partNumber)) {
        onProgress?.(end, file.size);
        continue;
      }
      const body = file.slice(start, end, file.type || "application/octet-stream");
      const etag = await uploadPart(credentials, state.uploadId, partNumber, body, signal);
      completed.set(partNumber, etag);
      state.parts = [...completed.entries()]
        .map(([number, value]) => ({ partNumber: number, etag: value }))
        .sort((left, right) => left.partNumber - right.partNumber);
      state.updatedAt = Date.now();
      saveState(state);
      onProgress?.(end, file.size);
    }

    await completeMultipartUpload(credentials, state.uploadId, state.parts, signal);
    clearState(state.fingerprint);
  } catch (error) {
    if (allowRestart && isMissingMultipart(error) && state) {
      clearState(state.fingerprint);
      return uploadMultipartR2({
        credentials,
        file,
        chunkSize,
        resume: { fingerprint: resume.fingerprint, state: null },
        signal,
        onProgress,
        allowRestart: false,
      });
    }
    throw error;
  }
}

async function createMultipartUpload(credentials: R2TemporaryCredentials, contentType: string, signal: AbortSignal) {
  const signing = await import("../../r2/services/r2Signing");
  const payloadHash = await signing.sha256Hex("");
  const signed = await signing.signedR2Request({
    credentials,
    method: "POST",
    objectKey: credentials.objectKey,
    payloadHash,
    contentType: contentType || "application/octet-stream",
    query: { uploads: "" },
    body: "",
  });
  const response = await fetch(signed.request, { signal });
  const text = await response.text();
  if (!response.ok) throw r2HttpError("创建分块上传", response.status, text);
  const uploadId = xmlValue(text, "UploadId");
  if (!uploadId) throw new Error("R2 没有返回分块上传编号。");
  return uploadId;
}

async function uploadPart(
  credentials: R2TemporaryCredentials,
  uploadId: string,
  partNumber: number,
  body: Blob,
  signal: AbortSignal,
) {
  const signing = await import("../../r2/services/r2Signing");
  const payloadHash = await signing.sha256Hex(await body.arrayBuffer());
  const signed = await signing.signedR2Request({
    credentials,
    method: "PUT",
    objectKey: credentials.objectKey,
    payloadHash,
    contentType: body.type || "application/octet-stream",
    query: { partNumber: String(partNumber), uploadId },
    body,
  });
  const response = await fetch(signed.request, { signal });
  if (!response.ok) throw r2HttpError("上传文件分块", response.status, await response.text());
  const etag = response.headers.get("etag")?.trim();
  if (!etag) throw new Error("R2 分块响应缺少 ETag，请检查对象存储 CORS exposeHeaders。");
  return etag;
}

async function completeMultipartUpload(
  credentials: R2TemporaryCredentials,
  uploadId: string,
  parts: MultipartResumeState["parts"],
  signal: AbortSignal,
) {
  const body = `<CompleteMultipartUpload>${parts.map((part) =>
    `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
  ).join("")}</CompleteMultipartUpload>`;
  const signing = await import("../../r2/services/r2Signing");
  const signed = await signing.signedR2Request({
    credentials,
    method: "POST",
    objectKey: credentials.objectKey,
    payloadHash: await signing.sha256Hex(body),
    contentType: "application/xml",
    query: { uploadId },
    body,
  });
  const response = await fetch(signed.request, { signal });
  const text = await response.text();
  if (!response.ok || /<Error(?:\s|>)/i.test(text)) {
    throw r2HttpError("完成分块上传", response.status, text);
  }
}

function alignedPartSize(fileSize: number, chunkSize: number) {
  const required = Math.max(minimumPartBytes, Math.ceil(fileSize / maxParts));
  return Math.ceil(required / chunkSize) * chunkSize;
}

async function fileFingerprint(file: File) {
  const signing = await import("../../r2/services/r2Signing");
  return signing.sha256Hex(`${file.name}\0${file.size}\0${file.lastModified}`);
}

function saveState(state: MultipartResumeState) {
  localResumeStorage()?.setItem(resumePrefix + state.fingerprint, JSON.stringify(state));
}

function clearState(fingerprint: string) {
  localResumeStorage()?.removeItem(resumePrefix + fingerprint);
}

function xmlValue(xml: string, name: string) {
  if (typeof DOMParser === "function") {
    return new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName(name)[0]?.textContent?.trim() ?? "";
  }
  return xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]?.trim() ?? "";
}

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function r2HttpError(operation: string, status: number, detail: string) {
  return new Error(`${operation}失败：HTTP ${status}${detail ? `，${detail.slice(0, 180)}` : ""}`);
}

function isMissingMultipart(error: unknown) {
  return error instanceof Error && /HTTP (404|409)/.test(error.message);
}

function isValidResumeState(value: MultipartResumeState | null, fingerprint: string): value is MultipartResumeState {
  if (
    value?.version !== 1 || value.fingerprint !== fingerprint || !value.objectKey || !value.uploadId ||
    !Array.isArray(value.parts) || !Number.isFinite(value.updatedAt) ||
    Date.now() - value.updatedAt >= 24 * 60 * 60 * 1000
  ) return false;
  const seen = new Set<number>();
  return value.parts.every((part) =>
    Number.isSafeInteger(part.partNumber) && part.partNumber >= 1 && part.partNumber <= maxParts &&
    typeof part.etag === "string" && part.etag.length > 0 && part.etag.length <= 256 &&
    !seen.has(part.partNumber) && Boolean(seen.add(part.partNumber)),
  );
}

function localResumeStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

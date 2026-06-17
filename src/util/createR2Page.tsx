import {
  Check,
  Copy,
  Database,
  Download,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  Link2,
  RefreshCw,
  Server,
  UploadCloud,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

import { PrimaryButton, SecondaryButton, StatusMessage, TextArea, TextInput } from "../component/TransferControls";
import {
  ActionPanel,
  FilePickerPanel,
  FilesPanel,
  MainPanelGrid,
  MetricGrid,
  ReceivedFilesPanel,
  RoleOption,
  StatusPanel,
  TransferPageGrid,
  TransferSteps,
  UploadPanel,
} from "../layout/TransferLayout";
import type { MetricItem, TransferStepItem } from "../layout/TransferLayout";

type R2Credentials = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type R2ConnectionCode = {
  kind: "cloudflare-r2-file-v1";
  accountId: string;
  bucket: string;
  objectKey: string;
  presignedUrl?: string;
  expiresAt?: number;
  file: {
    name: string;
    size: number;
    type: string;
    lastModified: number;
  };
  createdAt: number;
};

type ReceivedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  receivedAt: string;
};

type Mode = "send" | "receive" | null;

const region = "auto";
const service = "s3";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function createStableId() {
  const randomUUID = (globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined)?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferFromBytes(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function encodeConnectionCode(payload: R2ConnectionCode) {
  const json = JSON.stringify(payload);
  const compression = globalThis.CompressionStream;
  if (!compression) {
    return `J1.${bytesToBase64Url(new TextEncoder().encode(json))}`;
  }

  const stream = new Blob([json]).stream().pipeThrough(new compression("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return `D1.${bytesToBase64Url(new Uint8Array(buffer))}`;
}

async function decodeConnectionCode(value: string): Promise<R2ConnectionCode> {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请先粘贴 R2 连接码。");

  let json: string;
  if (trimmed.startsWith("J1.")) {
    json = new TextDecoder().decode(base64UrlToBytes(trimmed.slice(3)));
  } else if (trimmed.startsWith("D1.")) {
    const decompression = globalThis.DecompressionStream;
    if (!decompression) {
      throw new Error("当前浏览器不能解压 D1 连接码，请换用最新版 Chrome、Edge 或 Safari。");
    }
    const bytes = base64UrlToBytes(trimmed.slice(3));
    const stream = new Blob([bytes]).stream().pipeThrough(new decompression("gzip"));
    json = await new Response(stream).text();
  } else {
    json = trimmed;
  }

  const payload = JSON.parse(json) as R2ConnectionCode;
  if (
    payload.kind !== "cloudflare-r2-file-v1" ||
    !payload.accountId ||
    !payload.bucket ||
    !payload.objectKey ||
    !payload.file?.name ||
    typeof payload.file.size !== "number"
  ) {
    throw new Error("R2 连接码格式不正确。");
  }
  return payload;
}

function sanitizeObjectSegment(value: string) {
  return value
    .trim()
    .replace(/[\\/#?]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function normalizePrefix(prefix: string) {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

function buildObjectKey(prefix: string, file: File) {
  const safePrefix = normalizePrefix(prefix) || "file-transfer";
  const date = new Date().toISOString().slice(0, 10);
  const name = sanitizeObjectSegment(file.name) || "download";
  return `${safePrefix}/${date}/${createStableId()}-${name}`;
}

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(bucket: string, objectKey: string) {
  return `/${encodePathSegment(bucket)}/${objectKey.split("/").map(encodePathSegment).join("/")}`;
}

function r2Endpoint(accountId: string) {
  return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}

function r2ObjectUrl(credentials: Pick<R2Credentials, "accountId" | "bucket">, objectKey: string) {
  return `${r2Endpoint(credentials.accountId)}${canonicalUri(credentials.bucket.trim(), objectKey)}`;
}

function getAmzDates(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodeQueryValue(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQueryString(params: Record<string, string>) {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeQueryValue(key)}=${encodeQueryValue(value)}`)
    .join("&");
}

async function sha256Hex(value: string | ArrayBuffer | Uint8Array) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("R2 签名需要浏览器 Web Crypto，请使用 HTTPS 或 localhost 打开页面。");
  }
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  return bytesToHex(await crypto.subtle.digest("SHA-256", arrayBufferFromBytes(bytes)));
}

async function hmac(key: string | Uint8Array, value: string) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("R2 签名需要浏览器 Web Crypto，请使用 HTTPS 或 localhost 打开页面。");
  }
  const rawKey = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBufferFromBytes(rawKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, arrayBufferFromBytes(new TextEncoder().encode(value))));
}

async function getSigningKey(secretAccessKey: string, dateStamp: string) {
  const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

async function signedR2Request({
  credentials,
  method,
  objectKey,
  payloadHash,
  contentType,
}: {
  credentials: R2Credentials;
  method: "GET" | "HEAD" | "PUT";
  objectKey: string;
  payloadHash: string;
  contentType?: string;
}) {
  const accountId = credentials.accountId.trim();
  const bucket = credentials.bucket.trim();
  const accessKeyId = credentials.accessKeyId.trim();
  const secretAccessKey = credentials.secretAccessKey.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("请填写 Account ID、Bucket、Access Key ID 和 Secret Access Key。");
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = getAmzDates();
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const canonicalRequest = [
    method,
    canonicalUri(bucket, objectKey),
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await getSigningKey(secretAccessKey, dateStamp);
  const signature = bytesToHex(await hmac(signingKey, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = new Headers({
    Authorization: authorization,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  if (contentType) headers.set("Content-Type", contentType);

  return {
    url: `${r2Endpoint(accountId)}${canonicalUri(bucket, objectKey)}`,
    headers,
  };
}

async function presignedR2Url({
  credentials,
  method,
  objectKey,
  expiresIn,
}: {
  credentials: R2Credentials;
  method: "GET" | "HEAD";
  objectKey: string;
  expiresIn: number;
}) {
  const accountId = credentials.accountId.trim();
  const bucket = credentials.bucket.trim();
  const accessKeyId = credentials.accessKeyId.trim();
  const secretAccessKey = credentials.secretAccessKey.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("请填写 Account ID、Bucket、Access Key ID 和 Secret Access Key。");
  }
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
    throw new Error("预签名下载链接有效期必须是 1 到 604800 秒。");
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = getAmzDates();
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const payloadHash = "UNSIGNED-PAYLOAD";
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": payloadHash,
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalRequest = [
    method,
    canonicalUri(bucket, objectKey),
    canonicalQueryString(query),
    `host:${host}\n`,
    "host",
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await getSigningKey(secretAccessKey, dateStamp);
  const signature = bytesToHex(await hmac(signingKey, stringToSign));
  return `${r2Endpoint(accountId)}${canonicalUri(bucket, objectKey)}?${canonicalQueryString({
    ...query,
    "X-Amz-Signature": signature,
  })}`;
}

async function copyText(text: string) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("复制失败，请手动选中文本复制。");
}

function saveBlob(file: ReceivedFile) {
  const anchor = document.createElement("a");
  anchor.href = file.url;
  anchor.download = file.name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function formatFetchError(error: unknown) {
  if (error instanceof TypeError) {
    return "浏览器请求 R2 失败。请检查 bucket CORS 是否允许当前页面 Origin、PUT/GET，以及上传所需的 Authorization、Content-Type、x-amz-date、x-amz-content-sha256。";
  }
  return error instanceof Error ? error.message : "R2 请求失败。";
}

export function createR2Page() {
  return function R2Page() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);

  const [accountId, setAccountId] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState("file-transfer");
  const [downloadTtl, setDownloadTtl] = useState("3600");
  const [mode, setMode] = useState<Mode>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [objectKey, setObjectKey] = useState("");
  const [connectionCode, setConnectionCode] = useState("");
  const [receiverCodeInput, setReceiverCodeInput] = useState("");
  const [incomingCode, setIncomingCode] = useState<R2ConnectionCode | null>(null);
  const [senderStatus, setSenderStatus] = useState("填写 R2 S3 API 凭证并选择文件后上传。");
  const [receiverStatus, setReceiverStatus] = useState("粘贴 R2 连接码后下载文件。");
  const [senderError, setSenderError] = useState("");
  const [receiverError, setReceiverError] = useState("");
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [senderProgress, setSenderProgress] = useState(0);
  const [receiverProgress, setReceiverProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);

  const credentials = useMemo<R2Credentials>(
    () => ({ accountId, bucket, accessKeyId, secretAccessKey }),
    [accountId, bucket, accessKeyId, secretAccessKey],
  );
  const totalBytes = selectedFile?.size ?? incomingCode?.file.size ?? 0;
  const progress = Math.max(senderProgress, receiverProgress);
  const endpointAccountId = accountId || incomingCode?.accountId || "";
  const endpointLabel = endpointAccountId ? `${endpointAccountId}.r2.cloudflarestorage.com` : "未配置";
  const objectUrl = objectKey ? r2ObjectUrl(credentials, objectKey) : incomingCode ? r2ObjectUrl(incomingCode, incomingCode.objectKey) : "";
  const expiresAtText = incomingCode?.expiresAt ? new Date(incomingCode.expiresAt).toLocaleString() : "未生成";

  function resetAll() {
    setMode(null);
    setSelectedFile(null);
    setObjectKey("");
    setConnectionCode("");
    setReceiverCodeInput("");
    setIncomingCode(null);
    setSenderStatus("填写 R2 S3 API 凭证并选择文件后上传。");
    setReceiverStatus("粘贴 R2 连接码后下载文件。");
    setSenderError("");
    setReceiverError("");
    setUploadedBytes(0);
    setDownloadedBytes(0);
    setSenderProgress(0);
    setReceiverProgress(0);
    setIsUploading(false);
    setIsDownloading(false);
  }

  function handleFile(file: File | null) {
    setSelectedFile(file);
    setConnectionCode("");
    setUploadedBytes(0);
    setSenderProgress(0);
    if (file) {
      const key = buildObjectKey(prefix, file);
      setObjectKey(key);
      setSenderStatus(`已选择 ${file.name}，对象 Key 已生成。`);
    } else {
      setObjectKey("");
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    handleFile(event.target.files?.[0] ?? null);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    handleFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function uploadSelectedFile() {
    if (!selectedFile) {
      setSenderError("请先选择一个文件。");
      return;
    }

    const key = objectKey.trim() || buildObjectKey(prefix, selectedFile);
    try {
      setIsUploading(true);
      setSenderError("");
      setConnectionCode("");
      setUploadedBytes(0);
      setSenderProgress(1);
      setSenderStatus("正在计算文件 SHA-256 并签名 R2 PUT 请求...");
      setObjectKey(key);
      const expiresIn = Number(downloadTtl);
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
        throw new Error("下载链接有效期必须是 1 到 604800 秒。");
      }

      const buffer = await selectedFile.arrayBuffer();
      const payloadHash = await sha256Hex(buffer);
      const signed = await signedR2Request({
        credentials,
        method: "PUT",
        objectKey: key,
        payloadHash,
        contentType: selectedFile.type || "application/octet-stream",
      });

      setSenderStatus("正在上传到 Cloudflare R2...");
      const response = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: buffer,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`R2 上传失败：HTTP ${response.status}${text ? `，${text.slice(0, 180)}` : ""}`);
      }

      setSenderStatus("正在生成预签名下载链接...");
      const presignedUrl = await presignedR2Url({
        credentials,
        method: "GET",
        objectKey: key,
        expiresIn,
      });
      const code = await encodeConnectionCode({
        kind: "cloudflare-r2-file-v1",
        accountId: credentials.accountId.trim(),
        bucket: credentials.bucket.trim(),
        objectKey: key,
        presignedUrl,
        expiresAt: Date.now() + expiresIn * 1000,
        file: {
          name: selectedFile.name,
          size: selectedFile.size,
          type: selectedFile.type,
          lastModified: selectedFile.lastModified,
        },
        createdAt: Date.now(),
      });
      setUploadedBytes(selectedFile.size);
      setSenderProgress(100);
      setConnectionCode(code);
      setSenderStatus(`文件已上传到 R2。预签名下载链接有效期 ${expiresIn} 秒，复制连接码给接收方。`);
    } catch (error) {
      setSenderError(formatFetchError(error));
      setSenderProgress(0);
      setUploadedBytes(0);
    } finally {
      setIsUploading(false);
    }
  }

  async function parseReceiverCode() {
    try {
      setReceiverError("");
      setDownloadedBytes(0);
      setReceiverProgress(0);
      const code = await decodeConnectionCode(receiverCodeInput);
      setIncomingCode(code);
      setReceiverStatus(
        code.presignedUrl
          ? `已读取连接码：${code.file.name}，${formatBytes(code.file.size)}。接收方无需 R2 凭证。`
          : "这个连接码缺少预签名下载链接，请让发送方用新版 R2 页面重新上传并复制连接码。",
      );
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : "读取 R2 连接码失败。");
    }
  }

  async function downloadFromR2() {
    try {
      const code = incomingCode ?? (receiverCodeInput.trim() ? await decodeConnectionCode(receiverCodeInput) : null);
      if (!code) {
        setReceiverError("请先粘贴并读取 R2 连接码。");
        return;
      }
      if (!code.presignedUrl) {
        throw new Error("这个连接码缺少预签名下载链接，请让发送方用新版 R2 页面重新上传并复制连接码。");
      }
      if (code.expiresAt && Date.now() > code.expiresAt) {
        throw new Error("预签名下载链接已过期，请让发送方重新上传或重新生成连接码。");
      }

      setIsDownloading(true);
      setReceiverError("");
      setIncomingCode(code);
      setDownloadedBytes(0);
      setReceiverProgress(1);
      setReceiverStatus("正在使用预签名链接从 Cloudflare R2 下载文件...");
      const response = await fetch(code.presignedUrl, {
        method: "GET",
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`R2 下载失败：HTTP ${response.status}${text ? `，${text.slice(0, 180)}` : ""}`);
      }

      const blob = await response.blob();
      const receivedFile: ReceivedFile = {
        id: `${Date.now()}-${code.file.name}`,
        name: code.file.name,
        size: blob.size,
        type: code.file.type,
        url: URL.createObjectURL(blob),
        receivedAt: new Date().toLocaleString(),
      };
      receivedFilesRef.current = [receivedFile, ...receivedFilesRef.current];
      setReceivedFiles(receivedFilesRef.current);
      setDownloadedBytes(blob.size);
      setReceiverProgress(100);
      setReceiverStatus("文件已从 R2 下载完成，已触发浏览器下载。");
      saveBlob(receivedFile);
    } catch (error) {
      setReceiverError(formatFetchError(error));
      setReceiverProgress(0);
      setDownloadedBytes(0);
    } finally {
      setIsDownloading(false);
    }
  }

  const codeSize = connectionCode ? `${connectionCode.length.toLocaleString()} 字符` : "";
  const credentialsReady =
    mode === "receive" ? Boolean(incomingCode?.presignedUrl || receiverCodeInput.trim()) : Boolean(accountId && bucket && accessKeyId && secretAccessKey);
  const steps: TransferStepItem[] = [
    {
      label: mode === "receive" ? "连接码" : "凭证",
      meta: credentialsReady ? (mode === "receive" ? "已粘贴" : "已填写") : mode === "receive" ? "等待粘贴" : "等待填写",
      icon: mode === "receive" ? Link2 : KeyRound,
      active: credentialsReady,
      connectorActive: credentialsReady,
    },
    {
      label: "对象",
      meta: objectKey || incomingCode?.objectKey ? "已定位" : "等待生成",
      icon: FileText,
      active: Boolean(objectKey || incomingCode?.objectKey),
      connectorActive: Boolean(objectKey || incomingCode?.objectKey),
    },
    {
      label: "传输",
      meta: isUploading || isDownloading ? "进行中" : progress >= 100 ? "已完成" : "等待开始",
      icon: UploadCloud,
      active: isUploading || isDownloading || progress >= 100,
      connectorActive: progress >= 100,
    },
    { label: "文件", meta: progress >= 100 ? "可下载" : "等待完成", icon: Check, active: progress >= 100, connectorActive: progress >= 100 },
  ];
  const details: MetricItem[] = [
    { label: "连接类型", value: "Cloudflare R2 S3 API", icon: Link2 },
    { label: "Endpoint", value: endpointLabel, icon: Server, active: Boolean(accountId) },
    { label: "Bucket", value: bucket || incomingCode?.bucket || "未配置", icon: Database, active: Boolean(bucket || incomingCode?.bucket) },
    { label: "对象 Key", value: objectKey || incomingCode?.objectKey || "未生成", icon: FileText, active: Boolean(objectKey || incomingCode?.objectKey) },
    { label: "对象 URL", value: objectUrl || "未生成", icon: Link2 },
    { label: "下载链接过期", value: expiresAtText, icon: Gauge, active: Boolean(incomingCode?.expiresAt) },
    { label: "选中文件", value: selectedFile ? selectedFile.name : incomingCode?.file.name ?? "未选择", icon: HardDrive },
    { label: "文件大小", value: totalBytes ? formatBytes(totalBytes) : "0 B", icon: Database },
    { label: "已上传", value: formatBytes(uploadedBytes), icon: UploadCloud },
    { label: "已下载", value: formatBytes(downloadedBytes), icon: Download },
    { label: "进度", value: formatPercent(progress), icon: Gauge, progress },
  ];

  return (
    <TransferPageGrid>
      <StatusPanel>
        <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">R2 传输状态</h2>
            <p className="mt-1 text-[15px] text-[#526c92]">通过 Cloudflare R2 S3 API 上传和下载临时文件。</p>
          </div>
          <SecondaryButton onClick={resetAll}>
            <RefreshCw aria-hidden="true" size={17} />
            重置
          </SecondaryButton>
        </div>

        <TransferSteps steps={steps} />

        <div className="my-5 h-px shrink-0 bg-[#e3edf9]" />

        <h2 className="mb-3 shrink-0 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
        <MetricGrid items={details} />
      </StatusPanel>

      <MainPanelGrid>
        <ActionPanel>
          <div className="mb-4">
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">Cloudflare R2</h2>
            <p className="mt-1 text-[15px] text-[#526c92]">
              {mode === "receive" ? "接收方只需要粘贴发送方的 R2 连接码。" : "发送方在浏览器内填写 R2 凭证，用于上传和生成预签名下载链接。"}
            </p>
          </div>

          {mode === "send" && (
            <div className="mb-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
              <TextInput label="Account ID" value={accountId} onChange={setAccountId} placeholder="Cloudflare account id" />
              <TextInput label="Bucket" value={bucket} onChange={setBucket} placeholder="R2 bucket name" />
              <TextInput label="Access Key ID" value={accessKeyId} onChange={setAccessKeyId} placeholder="R2 access key id" />
              <TextInput label="Secret Access Key" value={secretAccessKey} onChange={setSecretAccessKey} placeholder="R2 secret access key" type="password" />
              <TextInput label="对象前缀" value={prefix} onChange={setPrefix} placeholder="file-transfer" />
              <TextInput label="下载链接有效期秒" value={downloadTtl} onChange={setDownloadTtl} placeholder="3600" />
            </div>
          )}

          {!mode && (
            <div className="grid gap-3">
              <RoleOption
                title="上传文件"
                description="上传到 R2 并复制连接码"
                icon={UploadCloud}
                onClick={() => setMode("send")}
              />
              <RoleOption
                title="下载文件"
                description="粘贴连接码并从 R2 拉取"
                icon={Download}
                onClick={() => setMode("receive")}
              />
            </div>
          )}

          {mode === "send" && (
            <div className="grid gap-4">
              <TextInput label="对象 Key" value={objectKey} onChange={setObjectKey} placeholder="选择文件后自动生成，也可以手动修改" />
              <TextArea
                label={`发送方 R2 连接码 ${codeSize}`}
                value={connectionCode}
                onChange={setConnectionCode}
                placeholder="上传完成后，把这一整串连接码复制给接收方"
                readOnly
              />
              <div className="flex flex-wrap gap-3">
                <PrimaryButton onClick={() => void uploadSelectedFile()} disabled={!selectedFile || isUploading}>
                  <UploadCloud aria-hidden="true" size={17} />
                  上传到 R2
                </PrimaryButton>
                <SecondaryButton onClick={() => void copyText(connectionCode).catch((error) => setSenderError(error.message))} disabled={!connectionCode}>
                  <Copy aria-hidden="true" size={17} />
                  复制连接码
                </SecondaryButton>
              </div>
              <StatusMessage message={senderError || senderStatus} tone={senderError ? "error" : "info"} />
            </div>
          )}

          {mode === "receive" && (
            <div className="grid gap-4">
              <TextArea
                label="发送方 R2 连接码"
                value={receiverCodeInput}
                onChange={setReceiverCodeInput}
                placeholder="把发送方复制出来的 R2 连接码粘贴到这里"
              />
              <div className="flex flex-wrap gap-3">
                <SecondaryButton onClick={() => void parseReceiverCode()} disabled={!receiverCodeInput.trim()}>
                  <FileText aria-hidden="true" size={17} />
                  读取连接码
                </SecondaryButton>
                <PrimaryButton onClick={() => void downloadFromR2()} disabled={isDownloading || (!incomingCode && !receiverCodeInput.trim())}>
                  <Download aria-hidden="true" size={17} />
                  下载文件
                </PrimaryButton>
              </div>
              <StatusMessage message={receiverError || receiverStatus} tone={receiverError ? "error" : "info"} />
            </div>
          )}
        </ActionPanel>

        <UploadPanel>
          <FilePickerPanel
            inputRef={fileInputRef}
            onFileInput={handleFileInput}
            onDrop={handleDrop}
            ariaLabel="选择上传文件"
            title={selectedFile?.name}
            titleFallback="点击或拖拽文件到此处上传"
            subtitle={selectedFile ? formatBytes(selectedFile.size) : "选择文件后上传到 Cloudflare R2"}
            onSelect={() => fileInputRef.current?.click()}
          />
        </UploadPanel>
      </MainPanelGrid>

      <FilesPanel>
        <ReceivedFilesPanel
          title="已下载文件"
          countLabel={`${receivedFiles.length} 个文件`}
          ariaLabel="已下载文件列表"
          emptyText="下载完成后，文件会出现在这里并自动触发下载。"
          files={receivedFiles}
          formatSize={formatBytes}
          onDownload={saveBlob}
        />
      </FilesPanel>
    </TransferPageGrid>
  );
  };
}

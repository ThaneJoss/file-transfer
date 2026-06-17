import {
  Check,
  Circle,
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
import type { ChangeEvent, DragEvent, ReactNode } from "react";

import { Panel } from "../components/Panel";

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
type StepStatus = "waiting" | "active" | "done";

const region = "auto";
const service = "s3";
const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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
    return "浏览器请求 R2 失败。请检查 bucket CORS 是否允许当前页面 Origin、Authorization、x-amz-date、x-amz-content-sha256、PUT/GET/HEAD。";
  }
  return error instanceof Error ? error.message : "R2 请求失败。";
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-extrabold text-[#233d64]">{label}</span>
      <input
        className="h-11 rounded-lg border border-[#d7e5f6] bg-white px-3 text-[14px] font-semibold text-[#17345f] outline-none transition placeholder:text-[#91a4c0] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        spellCheck={false}
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  readOnly?: boolean;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-extrabold text-[#233d64]">{label}</span>
      <textarea
        className={`h-[clamp(120px,18dvh,180px)] min-h-0 resize-none rounded-xl border border-[#d7e5f6] px-3 py-3 font-mono text-[12px] leading-relaxed text-[#17345f] outline-none transition placeholder:text-[#91a4c0] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10 max-[560px]:h-[136px] ${
          readOnly ? "bg-[#f7fbff]" : "bg-white"
        }`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck={false}
      />
    </label>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#1677ff] px-5 text-[15px] font-extrabold text-white shadow-[0_12px_22px_rgba(47,125,246,0.22)] transition hover:-translate-y-px hover:bg-[#0d63da] disabled:cursor-not-allowed disabled:bg-[#a9bdd8] disabled:shadow-none disabled:hover:translate-y-0"
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#d7e5f6] bg-white px-4 text-[15px] font-extrabold text-[#17345f] transition hover:-translate-y-px hover:border-[#9ec7ff] disabled:cursor-not-allowed disabled:text-[#98a9c0] disabled:hover:translate-y-0"
      type="button"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function StatusMessage({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "info";
}) {
  return (
    <p
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={`flex min-h-11 min-w-0 items-center rounded-xl px-4 text-[14px] ${
        tone === "error" ? "bg-[#fff0f0] text-[#b4232b]" : "bg-[#edf6ff] text-[#365a88]"
      }`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  active = false,
  progress,
}: {
  label: string;
  value: string;
  icon: typeof Circle;
  active?: boolean;
  progress?: number;
}) {
  return (
    <div className="grid min-h-[62px] grid-cols-[30px_minmax(0,1fr)] items-center gap-2.5 rounded-xl border border-[#dfeaf7] bg-white/65 px-3 py-2.5 text-[13px] shadow-[0_6px_16px_rgba(16,34,59,0.025)]">
      <span className="grid size-[30px] place-items-center rounded-lg bg-[#eef6ff] text-[#1677ff]">
        <Icon aria-hidden="true" size={16} />
      </span>
      {progress == null ? (
        <span className="min-w-0">
          <span className="block whitespace-nowrap text-[#6a7f9e]">{label}</span>
          <strong className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[14px] font-extrabold text-[#142a4f]">
            {active && <span className="inline-block size-2 shrink-0 rounded-full bg-[#1dc85f]" />}
            <span className="min-w-0 truncate">{value}</span>
          </strong>
        </span>
      ) : (
        <span className="grid min-w-0 gap-1.5">
          <span className="flex items-center justify-between gap-2">
            <span className="whitespace-nowrap text-[#6a7f9e]">{label}</span>
            <strong className="text-[14px] font-extrabold text-[#142a4f]">{value}</strong>
          </span>
          <span className="h-1.5 rounded-full bg-[#dce8f7]">
            <span className="block h-full rounded-full bg-[#1677ff]" style={{ width: `${progress}%` }} />
          </span>
        </span>
      )}
    </div>
  );
}

export default function R2Page() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);

  const [accountId, setAccountId] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState("file-transfer");
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
  const endpointLabel = accountId ? `${accountId}.r2.cloudflarestorage.com` : "未配置";
  const objectUrl = objectKey ? r2ObjectUrl(credentials, objectKey) : incomingCode ? r2ObjectUrl(incomingCode, incomingCode.objectKey) : "";

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

      const code = await encodeConnectionCode({
        kind: "cloudflare-r2-file-v1",
        accountId: credentials.accountId.trim(),
        bucket: credentials.bucket.trim(),
        objectKey: key,
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
      setSenderStatus("文件已上传到 R2。复制连接码给接收方。");
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
      if (!accountId) setAccountId(code.accountId);
      if (!bucket) setBucket(code.bucket);
      setReceiverStatus(`已读取连接码：${code.file.name}，${formatBytes(code.file.size)}。`);
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

      setIsDownloading(true);
      setReceiverError("");
      setIncomingCode(code);
      setDownloadedBytes(0);
      setReceiverProgress(1);
      setReceiverStatus("正在签名 R2 GET 请求...");

      const signed = await signedR2Request({
        credentials: {
          accountId: accountId.trim() || code.accountId,
          bucket: bucket.trim() || code.bucket,
          accessKeyId,
          secretAccessKey,
        },
        method: "GET",
        objectKey: code.objectKey,
        payloadHash: emptySha256,
      });

      setReceiverStatus("正在从 Cloudflare R2 下载文件...");
      const response = await fetch(signed.url, {
        method: "GET",
        headers: signed.headers,
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
  const credentialsReady = Boolean(accountId && bucket && accessKeyId && secretAccessKey);
  const steps: Array<{ label: string; meta: string; icon: typeof Circle; status: StepStatus }> = [
    { label: "凭证", meta: credentialsReady ? "已填写" : "等待填写", icon: KeyRound, status: credentialsReady ? "done" : "waiting" },
    { label: "对象", meta: objectKey || incomingCode?.objectKey ? "已定位" : "等待生成", icon: FileText, status: objectKey || incomingCode?.objectKey ? "done" : "waiting" },
    { label: "传输", meta: isUploading || isDownloading ? "进行中" : progress >= 100 ? "已完成" : "等待开始", icon: UploadCloud, status: isUploading || isDownloading ? "active" : progress >= 100 ? "done" : "waiting" },
    { label: "文件", meta: progress >= 100 ? "可下载" : "等待完成", icon: Check, status: progress >= 100 ? "done" : "waiting" },
  ];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(340px,0.92fr)_minmax(0,1.85fr)] grid-rows-[auto_minmax(180px,0.5fr)] gap-[clamp(12px,1.2vw,18px)] max-[1180px]:grid-cols-1 max-[1180px]:grid-rows-none max-[1180px]:gap-[clamp(14px,1.5vw,22px)]">
      <Panel className="row-span-2 flex min-h-0 flex-col overflow-hidden p-[clamp(16px,1.45vw,22px)] max-[1180px]:row-span-1 max-[1180px]:overflow-visible max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
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

        <div className="relative grid shrink-0 grid-cols-4 items-start max-[620px]:grid-cols-1 max-[620px]:gap-5">
          <div className="absolute left-[12.5%] right-[12.5%] top-[26px] grid grid-cols-3 max-[620px]:hidden">
            {steps.slice(0, -1).map((step) => (
              <span className={`mx-7 h-[3px] rounded-full ${step.status === "done" ? "bg-[#1677ff]" : "bg-[#cdd8e7]"}`} key={`connector-${step.label}`} />
            ))}
          </div>
          {steps.map((step) => {
            const Icon = step.icon;
            const active = step.status !== "waiting";
            return (
              <div className="relative z-10 grid min-w-0 justify-items-center text-center max-[620px]:grid-cols-[56px_1fr] max-[620px]:justify-items-start max-[620px]:gap-3 max-[620px]:text-left" key={step.label}>
                <span className={`grid size-[54px] place-items-center rounded-2xl text-white shadow-[0_10px_25px_rgba(47,125,246,0.25)] ${active ? "bg-[#1677ff]" : "bg-[#aeb8c8]"}`}>
                  <Icon aria-hidden="true" size={25} />
                </span>
                <div className="min-w-0">
                  <strong className="mt-4 block truncate text-[15px] font-extrabold text-[#071b3a] max-[620px]:mt-1">{step.label}</strong>
                  <span className="mt-2 block truncate text-sm text-[#667a9a] max-[620px]:mt-0">{step.meta}</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="my-5 h-px shrink-0 bg-[#e3edf9]" />

        <h2 className="mb-3 shrink-0 text-[22px] font-extrabold text-[#061b3a]">连接详情</h2>
        <div className="grid shrink-0 grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
          <Metric label="连接类型" value="Cloudflare R2 S3 API" icon={Link2} />
          <Metric label="Endpoint" value={endpointLabel} icon={Server} active={Boolean(accountId)} />
          <Metric label="Bucket" value={bucket || incomingCode?.bucket || "未配置"} icon={Database} active={Boolean(bucket || incomingCode?.bucket)} />
          <Metric label="对象 Key" value={objectKey || incomingCode?.objectKey || "未生成"} icon={FileText} active={Boolean(objectKey || incomingCode?.objectKey)} />
          <Metric label="对象 URL" value={objectUrl || "未生成"} icon={Link2} />
          <Metric label="选中文件" value={selectedFile ? selectedFile.name : incomingCode?.file.name ?? "未选择"} icon={HardDrive} />
          <Metric label="文件大小" value={totalBytes ? formatBytes(totalBytes) : "0 B"} icon={Database} />
          <Metric label="已上传" value={formatBytes(uploadedBytes)} icon={UploadCloud} />
          <Metric label="已下载" value={formatBytes(downloadedBytes)} icon={Download} />
          <Metric label="进度" value={formatPercent(progress)} icon={Gauge} progress={progress} />
        </div>
      </Panel>

      <div className="grid min-h-0 grid-cols-2 gap-[clamp(12px,1.2vw,18px)] max-[980px]:grid-cols-1 max-[980px]:gap-[clamp(14px,1.5vw,22px)]">
        <Panel className="min-h-0 overflow-visible p-[clamp(16px,1.45vw,22px)] max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
          <div className="mb-4">
            <h2 className="text-[22px] font-extrabold text-[#061b3a]">Cloudflare R2</h2>
            <p className="mt-1 text-[15px] text-[#526c92]">Access Key ID / Secret Access Key 由用户在浏览器内填写。</p>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
            <TextInput label="Account ID" value={accountId} onChange={setAccountId} placeholder="Cloudflare account id" />
            <TextInput label="Bucket" value={bucket} onChange={setBucket} placeholder="R2 bucket name" />
            <TextInput label="Access Key ID" value={accessKeyId} onChange={setAccessKeyId} placeholder="R2 access key id" />
            <TextInput label="Secret Access Key" value={secretAccessKey} onChange={setSecretAccessKey} placeholder="R2 secret access key" type="password" />
            <div className="col-span-2 max-[720px]:col-span-1">
              <TextInput label="对象前缀" value={prefix} onChange={setPrefix} placeholder="file-transfer" />
            </div>
          </div>

          {!mode && (
            <div className="grid gap-3">
              <button
                className="grid min-h-[68px] grid-cols-[22px_34px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-[#d7e5f6] bg-white/80 px-3 text-left transition hover:-translate-y-px hover:border-[#1677ff] hover:bg-white"
                type="button"
                onClick={() => setMode("send")}
              >
                <span className="size-4 rounded-full border border-[#9aabc4]" />
                <UploadCloud aria-hidden="true" className="text-[#6e82a0]" size={23} />
                <span className="min-w-0">
                  <strong className="block text-[15px] font-extrabold text-[#071b3a]">上传文件</strong>
                  <span className="block truncate text-[13px] text-[#526c92]">上传到 R2 并复制连接码</span>
                </span>
              </button>
              <button
                className="grid min-h-[68px] grid-cols-[22px_34px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-[#d7e5f6] bg-white/80 px-3 text-left transition hover:-translate-y-px hover:border-[#1677ff] hover:bg-white"
                type="button"
                onClick={() => setMode("receive")}
              >
                <span className="size-4 rounded-full border border-[#9aabc4]" />
                <Download aria-hidden="true" className="text-[#6e82a0]" size={23} />
                <span className="min-w-0">
                  <strong className="block text-[15px] font-extrabold text-[#071b3a]">下载文件</strong>
                  <span className="block truncate text-[13px] text-[#526c92]">粘贴连接码并从 R2 拉取</span>
                </span>
              </button>
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
        </Panel>

        <Panel className="min-h-0 overflow-hidden p-[clamp(16px,1.45vw,22px)] max-[1180px]:overflow-visible max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
          <div
            className="grid h-full min-h-[220px] place-items-center rounded-2xl border-2 border-dashed border-[#bdd3f1] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(244,249,255,0.78))] px-5 py-5 text-center max-[1180px]:min-h-[300px] max-[1180px]:py-7"
            onDrop={handleDrop}
            onDragOver={(event) => event.preventDefault()}
            aria-label="选择上传文件"
          >
            <input ref={fileInputRef} className="hidden" type="file" onChange={handleFileInput} />
            <div className="mb-4 grid size-[clamp(64px,7.5dvh,82px)] place-items-center rounded-3xl bg-[#1677ff] text-white shadow-[0_16px_32px_rgba(47,125,246,0.28)] max-[1180px]:size-[82px]">
              <UploadCloud aria-hidden="true" size={46} />
            </div>
            <strong className="block h-[30px] w-full max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[20px] font-extrabold leading-[30px] text-[#071b3a]" title={selectedFile?.name}>
              {selectedFile ? selectedFile.name : "点击或拖拽文件到此处上传"}
            </strong>
            <span className="mt-1 text-[14px] text-[#526c92]">{selectedFile ? formatBytes(selectedFile.size) : "选择文件后上传到 Cloudflare R2"}</span>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <PrimaryButton onClick={() => fileInputRef.current?.click()}>
                <HardDrive aria-hidden="true" size={17} />
                选择文件
              </PrimaryButton>
            </div>
          </div>
        </Panel>
      </div>

      <Panel className="flex min-h-0 flex-col overflow-hidden p-[clamp(16px,1.45vw,22px)] max-[1180px]:overflow-visible max-[1180px]:p-[clamp(18px,1.8vw,28px)]">
        <div className="mb-4 flex shrink-0 items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-start">
          <h2 className="m-0 text-[26px] font-extrabold text-[#061b3a]">已下载文件</h2>
          <span className="rounded-lg border border-[#d7e5f6] bg-white px-4 py-2 text-[15px] font-medium text-[#526c92]">{receivedFiles.length} 个文件</span>
        </div>

        <div className={`grid min-h-0 gap-3 ${receivedFiles.length > 0 ? "overflow-auto pr-1" : "overflow-hidden"}`} role="table" aria-label="已下载文件列表">
          {receivedFiles.length === 0 ? (
            <div className="grid min-h-[108px] place-items-center rounded-xl border border-dashed border-[#c7daf2] bg-white/70 text-[15px] text-[#607a9f]">
              下载完成后，文件会出现在这里并自动触发下载。
            </div>
          ) : (
            receivedFiles.map((file) => (
              <article
                className="grid min-h-[72px] grid-cols-[minmax(180px,1.8fr)_minmax(92px,0.55fr)_minmax(170px,0.9fr)_minmax(124px,0.5fr)] items-center gap-4 rounded-xl border border-[#e0eaf7] bg-white px-4 text-[15px] text-[#355176] shadow-[0_8px_22px_rgba(16,34,59,0.035)] max-[900px]:grid-cols-1 max-[900px]:gap-2.5 max-[900px]:p-4"
                key={file.id}
                role="row"
              >
                <div className="flex min-w-0 items-center gap-3 text-[#071b3a]" role="cell">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-[#20c263] text-white shadow-sm">
                    <FileText aria-hidden="true" size={17} />
                  </span>
                  <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[16px] font-extrabold">{file.name}</strong>
                </div>
                <span role="cell">{formatBytes(file.size)}</span>
                <time role="cell">{file.receivedAt}</time>
                <button
                  className="inline-flex min-h-[34px] items-center justify-center gap-1.5 rounded-lg border border-[#d7e5f6] bg-white px-3 text-[15px] font-extrabold text-[#1677ff] transition hover:border-[#9ec7ff]"
                  type="button"
                  onClick={() => saveBlob(file)}
                >
                  <Download aria-hidden="true" size={17} />
                  下载
                </button>
              </article>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

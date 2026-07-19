import { AwsClient } from "aws4fetch";

export type R2Credentials = {
  accountId: string;
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

const region = "auto";
const service = "s3";

function bytesToHex(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferFromBytes(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalUri(bucket: string, objectKey: string) {
  return `/${encodePathSegment(bucket)}/${objectKey.split("/").map(encodePathSegment).join("/")}`;
}

export function r2Endpoint(credentials: Pick<R2Credentials, "endpoint">) {
  return credentials.endpoint.trim().replace(/\/+$/, "");
}

export function r2ObjectUrl(credentials: Pick<R2Credentials, "endpoint" | "bucket">, objectKey: string) {
  return `${r2Endpoint(credentials)}${canonicalUri(credentials.bucket.trim(), objectKey)}`;
}

function encodeQueryValue(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQueryString(params: Record<string, string>) {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeQueryValue(key)}=${encodeQueryValue(value)}`)
    .join("&");
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array) {
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

function amzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function assertCompleteCredentials(credentials: R2Credentials) {
  const accountId = credentials.accountId.trim();
  const bucket = credentials.bucket.trim();
  const accessKeyId = credentials.accessKeyId.trim();
  const secretAccessKey = credentials.secretAccessKey.trim();
  const sessionToken = credentials.sessionToken.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey || !sessionToken || !credentials.endpoint.trim()) {
    throw new Error("R2 临时凭证不完整，请重新申请。");
  }

  return { accountId, bucket, accessKeyId, secretAccessKey, sessionToken };
}

function r2Client(credentials: R2Credentials) {
  const { accessKeyId, secretAccessKey, sessionToken } = assertCompleteCredentials(credentials);
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    service,
    region,
    retries: 0,
  });
}

export async function signedR2Request({
  credentials,
  method,
  objectKey,
  payloadHash,
  contentType,
  body,
  query,
  now,
}: {
  credentials: R2Credentials;
  method: "GET" | "HEAD" | "PUT" | "POST" | "DELETE";
  objectKey: string;
  payloadHash: string;
  contentType?: string;
  body?: BodyInit | null;
  query?: Record<string, string>;
  now?: Date;
}) {
  const { bucket } = assertCompleteCredentials(credentials);
  const headers = new Headers({
    "Content-Type": contentType || "application/octet-stream",
    "x-amz-content-sha256": payloadHash,
  });
  const url = new URL(r2ObjectUrl(credentials, objectKey));
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  const request = await r2Client(credentials).sign(url, {
    method,
    headers,
    body,
    aws: {
      allHeaders: true,
      datetime: now ? amzDate(now) : undefined,
    },
  });

  return {
    request,
    url: request.url,
    headers: request.headers,
    signedHeaders: request.headers.get("authorization")?.match(/SignedHeaders=([^,]+)/)?.[1] ?? "",
    canonicalPath: canonicalUri(bucket, objectKey),
  };
}

export async function presignedR2Url({
  credentials,
  method,
  objectKey,
  expiresIn,
  now,
}: {
  credentials: R2Credentials;
  method: "GET" | "HEAD";
  objectKey: string;
  expiresIn: number;
  now?: Date;
}) {
  assertCompleteCredentials(credentials);
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
    throw new Error("预签名下载链接有效期必须是 1 到 604800 秒。");
  }

  const url = new URL(r2ObjectUrl(credentials, objectKey));
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const request = await r2Client(credentials).sign(url, {
    method,
    aws: {
      datetime: now ? amzDate(now) : undefined,
      signQuery: true,
    },
  });
  return request.url;
}

export function formatFetchError(error: unknown) {
  if (error instanceof TypeError) {
    return "浏览器请求 R2 失败。请检查 bucket CORS 是否允许当前页面 Origin、PUT/GET，以及上传所需的 Authorization、Content-Type、x-amz-date、x-amz-content-sha256、x-amz-security-token。";
  }
  return error instanceof Error ? error.message : "R2 请求失败。";
}

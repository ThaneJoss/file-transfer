import { createStableId } from "../../../lib/browser/stableId";

export type R2Credentials = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
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

export function sanitizeObjectSegment(value: string) {
  return value
    .trim()
    .replace(/[\\/#?]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

export function normalizePrefix(prefix: string) {
  return prefix.trim().replace(/^\/+|\/+$/g, "");
}

export function buildObjectKey(prefix: string, file: Pick<File, "name">) {
  const safePrefix = normalizePrefix(prefix) || "file-transfer";
  const date = new Date().toISOString().slice(0, 10);
  const name = sanitizeObjectSegment(file.name) || "download";
  return `${safePrefix}/${date}/${createStableId()}-${name}`;
}

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalUri(bucket: string, objectKey: string) {
  return `/${encodePathSegment(bucket)}/${objectKey.split("/").map(encodePathSegment).join("/")}`;
}

export function r2Endpoint(accountId: string) {
  return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}

export function r2ObjectUrl(credentials: Pick<R2Credentials, "accountId" | "bucket">, objectKey: string) {
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

export async function signedR2Request({
  credentials,
  method,
  objectKey,
  payloadHash,
  contentType,
  now,
}: {
  credentials: R2Credentials;
  method: "GET" | "HEAD" | "PUT";
  objectKey: string;
  payloadHash: string;
  contentType?: string;
  now?: Date;
}) {
  const accountId = credentials.accountId.trim();
  const bucket = credentials.bucket.trim();
  const accessKeyId = credentials.accessKeyId.trim();
  const secretAccessKey = credentials.secretAccessKey.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("请填写 Account ID、Bucket、Access Key ID 和 Secret Access Key。");
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = getAmzDates(now);
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
    canonicalRequest,
    url: `${r2Endpoint(accountId)}${canonicalUri(bucket, objectKey)}`,
    headers,
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
  const { amzDate, dateStamp } = getAmzDates(now);
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

export function formatFetchError(error: unknown) {
  if (error instanceof TypeError) {
    return "浏览器请求 R2 失败。请检查 bucket CORS 是否允许当前页面 Origin、PUT/GET，以及上传所需的 Authorization、Content-Type、x-amz-date、x-amz-content-sha256。";
  }
  return error instanceof Error ? error.message : "R2 请求失败。";
}

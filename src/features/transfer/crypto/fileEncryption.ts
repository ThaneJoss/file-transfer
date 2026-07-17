import type { TransferEncryptionMetadata } from "../protocol/fileProtocol";

export type TransferEncryptionContext = {
  metadata: TransferEncryptionMetadata;
  key: CryptoKey;
  secret: string;
  resumeId?: string;
};

const encryptionResumePrefix = "file-transfer:encryption:";

export async function createTransferEncryption(file?: Pick<File, "name" | "size" | "lastModified">): Promise<TransferEncryptionContext> {
  const resumeId = file ? await sha256Hex(new TextEncoder().encode(`${file.name}\0${file.size}\0${file.lastModified}`)) : undefined;
  const storage = localEncryptionStorage();
  if (resumeId && storage) {
    try {
      const saved = JSON.parse(storage.getItem(encryptionResumePrefix + resumeId) ?? "null") as {
        secret?: string;
        metadata?: TransferEncryptionMetadata;
        updatedAt?: number;
      } | null;
      if (saved?.secret && saved.metadata && Date.now() - (saved.updatedAt ?? 0) < 24 * 60 * 60 * 1000) {
        const key = await importTransferEncryptionKey(saved.secret, saved.metadata);
        return { key, secret: saved.secret, metadata: saved.metadata, resumeId };
      }
    } catch {
      storage.removeItem(encryptionResumePrefix + resumeId);
    }
  }
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const key = await crypto.subtle.importKey("raw", arrayBuffer(rawKey), "AES-GCM", false, ["encrypt", "decrypt"]);
  const context: TransferEncryptionContext = {
    key,
    secret: base64UrlEncode(rawKey),
    metadata: {
      algorithm: "AES-GCM-256",
      keyId: await sha256Hex(rawKey),
      noncePrefix: base64UrlEncode(noncePrefix),
      tagBytes: 16,
    },
    ...(resumeId ? { resumeId } : {}),
  };
  if (resumeId && storage) {
    storage.setItem(encryptionResumePrefix + resumeId, JSON.stringify({
      secret: context.secret,
      metadata: context.metadata,
      updatedAt: Date.now(),
    }));
  }
  return context;
}

export function clearTransferEncryptionResume(context: TransferEncryptionContext | null | undefined) {
  if (context?.resumeId) {
    localEncryptionStorage()?.removeItem(encryptionResumePrefix + context.resumeId);
  }
}

export async function importTransferEncryptionKey(secret: string, metadata: TransferEncryptionMetadata) {
  let rawKey: Uint8Array;
  try {
    rawKey = base64UrlDecode(secret);
  } catch {
    throw new Error("分享链接中的端到端加密密钥无效。");
  }
  if (rawKey.byteLength !== 32 || await sha256Hex(rawKey) !== metadata.keyId) {
    throw new Error("分享链接中的端到端加密密钥与取件码不匹配。");
  }
  return crypto.subtle.importKey("raw", arrayBuffer(rawKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptTransferChunk(
  key: CryptoKey,
  metadata: TransferEncryptionMetadata,
  sequence: number,
  plaintext: Uint8Array,
) {
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce(metadata, sequence), tagLength: metadata.tagBytes * 8 },
    key,
    arrayBuffer(plaintext),
  );
  return new Uint8Array(encrypted);
}

export async function decryptTransferChunk(
  key: CryptoKey,
  metadata: TransferEncryptionMetadata,
  sequence: number,
  ciphertext: Uint8Array,
) {
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce(metadata, sequence), tagLength: metadata.tagBytes * 8 },
      key,
      arrayBuffer(ciphertext),
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new Error(`文件分块 ${sequence} 端到端解密失败。`);
  }
}

export function encryptedTransferSize(fileSize: number, chunkSize: number, tagBytes = 16) {
  const chunks = fileSize === 0 ? 0 : Math.ceil(fileSize / chunkSize);
  return fileSize + chunks * tagBytes;
}

export function encryptionSecretFromHash(hash = window.location.hash) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("key");
  return value?.trim() ?? "";
}

function nonce(metadata: TransferEncryptionMetadata, sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new Error("加密分块序号无效。");
  }
  const prefix = base64UrlDecode(metadata.noncePrefix);
  if (prefix.byteLength !== 8) throw new Error("加密随机数前缀无效。");
  const value = new Uint8Array(12);
  value.set(prefix);
  new DataView(value.buffer).setUint32(8, sequence);
  return value;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function localEncryptionStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

import { beforeEach, describe, expect, it } from "vitest";

import {
  createTransferEncryption,
  clearTransferEncryptionResume,
  decryptTransferChunk,
  encryptedTransferSize,
  encryptTransferChunk,
  importTransferEncryptionKey,
  persistTransferEncryptionResume,
} from "./fileEncryption";

describe("file transfer encryption", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  });

  it("round trips independently authenticated chunks", async () => {
    const context = await createTransferEncryption();
    const plaintext = new TextEncoder().encode("private file content");
    const encrypted = await encryptTransferChunk(context.key, context.metadata, 7, plaintext);
    expect(encrypted.byteLength).toBe(plaintext.byteLength + 16);
    const decrypted = await decryptTransferChunk(context.key, context.metadata, 7, encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe("private file content");
    await expect(decryptTransferChunk(context.key, context.metadata, 8, encrypted)).rejects.toThrow("解密失败");
  });

  it("keeps the key out of protocol metadata and validates the shared secret", async () => {
    const context = await createTransferEncryption();
    expect(JSON.stringify(context.metadata)).not.toContain(context.secret);
    await expect(importTransferEncryptionKey(context.secret, context.metadata)).resolves.toBeInstanceOf(CryptoKey);
    const replacement = await createTransferEncryption();
    await expect(importTransferEncryptionKey(replacement.secret, context.metadata)).rejects.toThrow("不匹配");
  });

  it("accounts for one authentication tag per chunk", () => {
    expect(encryptedTransferSize(0, 48 * 1024)).toBe(0);
    expect(encryptedTransferSize(48 * 1024 + 1, 48 * 1024)).toBe(48 * 1024 + 1 + 32);
  });

  it("reuses the same key for an interrupted file and clears it after success", async () => {
    const file = new File(["resume"], "resume.txt", { lastModified: 123 });
    const fileSha256 = "a".repeat(64);
    const first = await createTransferEncryption(file);
    persistTransferEncryptionResume(first, fileSha256);
    const resumed = await createTransferEncryption(file, { hashFile: async () => fileSha256 });
    expect(resumed.secret).toBe(first.secret);
    expect(resumed.fileSha256).toBe(fileSha256);

    clearTransferEncryptionResume(first);
    const next = await createTransferEncryption(file, { hashFile: async () => fileSha256 });
    expect(next.secret).not.toBe(first.secret);
  });

  it("never reuses a key when file metadata matches but content does not", async () => {
    const original = new File(["same"], "collision.txt", { lastModified: 456 });
    const replacement = new File(["diff"], "collision.txt", { lastModified: 456 });
    expect(replacement.size).toBe(original.size);

    const first = await createTransferEncryption(original);
    persistTransferEncryptionResume(first, "a".repeat(64));
    const changed = await createTransferEncryption(replacement, { hashFile: async () => "b".repeat(64) });

    expect(changed.secret).not.toBe(first.secret);
    expect(changed.metadata.noncePrefix).not.toBe(first.metadata.noncePrefix);
  });
});

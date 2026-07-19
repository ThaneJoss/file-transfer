import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { R2TemporaryCredentials } from "../../r2/services/r2Credentials";
import { loadMultipartResume, uploadMultipartR2 } from "./r2Multipart";

const credentials: R2TemporaryCredentials = {
  accountId: "account",
  bucket: "bucket",
  endpoint: "https://account.r2.cloudflarestorage.com",
  objectKey: "users/test/hello.txt",
  accessKeyId: "temporary-id",
  secretAccessKey: "temporary-secret",
  sessionToken: "temporary-token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("R2 multipart upload", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("persists completed parts and resumes by completing the same upload", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain", lastModified: 123 });
    const firstResume = await loadMultipartResume(file);
    let completionAttempts = 0;
    const requests: Array<{ method: string; url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = await request.clone().text();
      requests.push({ method: request.method, url: request.url, body });
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>");
      }
      if (request.method === "PUT") {
        return new Response("", { headers: { ETag: '"etag-1"' } });
      }
      completionAttempts += 1;
      return completionAttempts === 1
        ? new Response("temporary failure", { status: 500 })
        : new Response("<CompleteMultipartUploadResult />");
    }));

    await expect(uploadMultipartR2({
      credentials,
      file,
      chunkSize: 48 * 1024,
      resume: firstResume,
      signal: new AbortController().signal,
    })).rejects.toThrow("完成分块上传失败");

    const savedResume = await loadMultipartResume(file);
    expect(savedResume.state).toMatchObject({
      objectKey: credentials.objectKey,
      uploadId: "upload-1",
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    });

    await uploadMultipartR2({
      credentials,
      file,
      chunkSize: 48 * 1024,
      resume: savedResume,
      signal: new AbortController().signal,
    });

    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(requests.filter((request) => new URL(request.url).searchParams.has("uploads"))).toHaveLength(1);
    expect(requests.at(-1)?.body).toContain("<PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag>");
    expect((await loadMultipartResume(file)).state).toBeNull();
  });

  it("treats a successful HTTP response containing an S3 Error as a failure", async () => {
    const file = new File(["hello"], "hello.txt", { lastModified: 456 });
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>upload-2</UploadId></InitiateMultipartUploadResult>");
      }
      if (request.method === "PUT") return new Response("", { headers: { ETag: '"etag-2"' } });
      return new Response("<Error><Code>InvalidPart</Code></Error>");
    }));

    await expect(uploadMultipartR2({
      credentials,
      file,
      chunkSize: 48 * 1024,
      resume: await loadMultipartResume(file),
      signal: new AbortController().signal,
    })).rejects.toThrow("InvalidPart");
  });
});

import { describe, expect, it } from "vitest";

import { canonicalQueryString, canonicalUri, presignedR2Url, sha256Hex, signedR2Request } from "./r2Signing";

const credentials = {
  accountId: "example-account",
  bucket: "bucket name",
  endpoint: "https://example-account.r2.cloudflarestorage.com",
  accessKeyId: "example-access-key",
  secretAccessKey: "fake-secret",
  sessionToken: "temporary-session-token/+==",
};

describe("R2 SigV4 signing", () => {
  it("hashes payloads with a standard SHA-256 vector", async () => {
    await expect(sha256Hex("")).resolves.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("encodes bucket and object key path segments canonically", () => {
    expect(canonicalUri("bucket name", "folder/a b+测试.txt")).toBe("/bucket%20name/folder/a%20b%2B%E6%B5%8B%E8%AF%95.txt");
  });

  it("sorts and encodes query parameters deterministically", () => {
    expect(canonicalQueryString({ b: "two words", a: "1+1" })).toBe("a=1%2B1&b=two%20words");
  });

  it("creates deterministic signed PUT headers for a fixed signing time", async () => {
    const result = await signedR2Request({
      credentials,
      method: "PUT",
      objectKey: "folder/demo.txt",
      payloadHash: await sha256Hex("hello"),
      contentType: "text/plain",
      body: "hello",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(result.url).toBe("https://example-account.r2.cloudflarestorage.com/bucket%20name/folder/demo.txt");
    expect(result.request.method).toBe("PUT");
    expect(result.headers.get("content-type")).toBe("text/plain");
    expect(result.headers.get("x-amz-date")).toBe("20260102T030405Z");
    expect(result.headers.get("x-amz-security-token")).toBe(credentials.sessionToken);
    expect(result.headers.get("authorization")).toContain("Credential=example-access-key/20260102/auto/s3/aws4_request");
    expect(result.headers.get("authorization")).toContain("content-type");
    expect(result.headers.get("authorization")).toContain("x-amz-content-sha256");
    expect(result.headers.get("authorization")).toContain("x-amz-security-token");
    expect(result.headers.get("authorization")).not.toContain(credentials.secretAccessKey);
    expect(result.signedHeaders).toBe("content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token");
  });

  it("creates deterministic presigned URLs without leaking the secret access key", async () => {
    const url = await presignedR2Url({
      credentials,
      method: "GET",
      objectKey: "folder/demo.txt",
      expiresIn: 3600,
      now: new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(url).toContain("X-Amz-Date=20260102T030405Z");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("X-Amz-Security-Token=temporary-session-token%2F%2B%3D%3D");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).not.toContain(credentials.secretAccessKey);
  });
});

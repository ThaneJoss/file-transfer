import { test, expect, type Page } from "@playwright/test";

import {
  apiBaseUrl,
  collectConsoleErrors,
  decodeConnectionCodePayload,
  expectNoConsoleErrors,
  installAppMocks,
  openRoute,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";

async function chooseUploadMode(page: Page) {
  await page.getByRole("button", { name: /发送文件/ }).click();
}

async function chooseDownloadMode(page: Page) {
  await page.getByRole("button", { name: /接收文件/ }).click();
}

async function mockR2Credentials(page: Page) {
  await page.route(`${apiBaseUrl}/v1/r2/credentials`, async (route) => {
    const request = route.request();
    expect(await request.postDataJSON()).toEqual({
      fileName: expect.any(String),
      fileSizeBytes: expect.any(Number),
      ttlSeconds: 900,
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        accountId: "example-account",
        bucket: "demo-bucket",
        endpoint: "https://example-account.r2.cloudflarestorage.com",
        objectKey: "users/server/folder/a b+测试.txt",
        accessKeyId: "temporary-access-key",
        secretAccessKey: "temporary-secret",
        sessionToken: "temporary-session-token/+==",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      }),
    });
  });
}

function r2Code(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    kind: "cloudflare-r2-file-v1",
    objectKey: "folder/demo.txt",
    presignedUrl: "https://example-account.r2.cloudflarestorage.com/demo-bucket/folder/demo.txt?X-Amz-Signature=fake",
    expiresAt: Date.now() + 3600_000,
    file: { name: "demo.txt", size: 5, type: "text/plain", lastModified: 1 },
    ...overrides,
  });
}

test.describe("R2 page", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(withoutExpectedNetworkDiagnostics(consoleErrors));
  });

  test("opens directly with R2 transfer controls", async ({ page }) => {
    await openRoute(page, "r2");
    await expect(page.getByRole("heading", { name: "R2 传输状态" })).toBeVisible();
    await expect(page.getByText("Cloudflare R2 S3 API", { exact: true })).toBeVisible();
    for (const label of ["Account ID", "Bucket", "Access Key ID", "Secret Access Key"]) {
      await expect(page.getByLabel(label)).toHaveCount(0);
    }
  });

  test("requests temporary credentials, signs a mocked PUT, and creates a secret-free connection payload", async ({ page }) => {
    await mockR2Credentials(page);
    await page.route("https://example-account.r2.cloudflarestorage.com/**", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("PUT");
      expect(request.url()).toContain("users/server/folder/a%20b%2B%E6%B5%8B%E8%AF%95.txt");
      expect(request.url()).not.toContain("temporary-secret");
      expect(request.headers().authorization).toContain("Credential=temporary-access-key/");
      expect(request.headers().authorization).toContain("x-amz-security-token");
      expect(request.headers()["x-amz-security-token"]).toBe("temporary-session-token/+==");
      await route.fulfill({ status: 200, body: "" });
    });

    await openRoute(page, "r2");
    await chooseUploadMode(page);
    await expect(page.getByRole("button", { name: /上传到 R2/ })).toBeDisabled();
    await selectFile(page, "r2-demo.txt");
    await expect(page.getByText(/对象 Key 由服务端生成/)).toBeVisible();
    await page.getByRole("button", { name: /上传到 R2/ }).click();
    await expect(page.getByLabel(/发送方 R2 连接码/)).not.toHaveValue("");
    await expect(page.getByText(/文件已上传到 R2/)).toBeVisible();
    const encoded = await page.getByLabel(/发送方 R2 连接码/).inputValue();
    const payload = await decodeConnectionCodePayload(page, encoded);
    expect(Object.keys(payload).sort()).toEqual(["expiresAt", "file", "kind", "objectKey", "presignedUrl"]);
    expect(payload).not.toHaveProperty("secretAccessKey");
    expect(payload).not.toHaveProperty("sessionToken");
    expect(payload.objectKey).toBe("users/server/folder/a b+测试.txt");
    expect(payload.presignedUrl).toContain("X-Amz-Security-Token=");
  });

  test("surfaces temporary credential failures", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/r2/credentials`, (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "R2 denied" }) }),
    );
    await openRoute(page, "r2");
    await chooseUploadMode(page);
    await selectFile(page, "r2-ttl.txt");
    await expect(page.getByRole("alert")).toContainText("R2 denied");
  });

  for (const status of [401, 403, 429, 500]) {
    test(`surfaces mocked R2 upload ${status} errors without leaking the secret`, async ({ page }) => {
      await mockR2Credentials(page);
      await page.route("https://example-account.r2.cloudflarestorage.com/**", async (route) => {
        expect(route.request().url()).not.toContain("fake-secret");
        await route.fulfill({ status, body: `mock ${status}` });
      });
      await openRoute(page, "r2");
      await chooseUploadMode(page);
      await selectFile(page, "r2-error.txt");
      await expect(page.getByText(/对象 Key 由服务端生成/)).toBeVisible();
      await page.getByRole("button", { name: /上传到 R2/ }).click();
      await expect(page.getByText(new RegExp(`HTTP ${status}`))).toBeVisible();
      await expect(page.getByText("temporary-secret")).toHaveCount(0);
    });
  }

  test("downloads from a mocked presigned URL, handles reset, and revokes object URLs on unmount", async ({ page }) => {
    await page.route("https://example-account.r2.cloudflarestorage.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "hello" }),
    );
    await openRoute(page, "r2");
    await chooseDownloadMode(page);
    await page.getByLabel("发送方 R2 连接码").fill(r2Code());
    await page.getByRole("button", { name: /读取连接码/ }).click();
    await expect(page.getByText(/已读取连接码/)).toBeVisible();
    await page.getByRole("button", { name: /下载文件/ }).click();
    await expect(page.getByText(/文件已从 R2 下载完成/)).toBeVisible();
    await expect(page.evaluate(() => window.__appTest.objectUrls.created)).resolves.toBeGreaterThan(0);

    await page.getByRole("button", { name: /重置/ }).click();
    await expect(page.evaluate(() => window.__appTest.objectUrls.revoked)).resolves.toBeGreaterThan(0);
  });

  test("rejects invalid, expired, failed, and interrupted downloads", async ({ page }) => {
    await openRoute(page, "r2");
    await chooseDownloadMode(page);
    await page.getByLabel("发送方 R2 连接码").fill("not-json");
    await page.getByRole("button", { name: /读取连接码/ }).click();
    await expect(page.getByRole("alert")).toContainText(/Unexpected token|R2 连接码格式不正确/);

    await page.getByLabel("发送方 R2 连接码").fill(r2Code({ expiresAt: Date.now() - 1000 }));
    await page.getByRole("button", { name: /下载文件/ }).click();
    await expect(page.getByRole("alert")).toContainText("预签名下载链接已过期");

    await page.route("https://example-account.r2.cloudflarestorage.com/**", (route) => route.fulfill({ status: 500, body: "server error" }));
    await page.getByLabel("发送方 R2 连接码").fill(r2Code({ expiresAt: Date.now() + 3600_000 }));
    await page.getByRole("button", { name: /下载文件/ }).click();
    await expect(page.getByRole("alert")).toContainText("HTTP 500");

    await page.unroute("https://example-account.r2.cloudflarestorage.com/**");
    await page.route("https://example-account.r2.cloudflarestorage.com/**", (route) => route.abort("failed"));
    await page.getByRole("button", { name: /下载文件/ }).click();
    await expect(page.getByRole("alert")).toContainText(/浏览器请求 R2 失败|Failed to fetch/);
  });
});

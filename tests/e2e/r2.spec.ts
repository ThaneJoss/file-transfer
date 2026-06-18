import { test, expect, type Page } from "@playwright/test";

import {
  collectConsoleErrors,
  expectActiveNav,
  expectNoConsoleErrors,
  expectNoHorizontalOverflow,
  expectSliderAligned,
  installAppMocks,
  openRoute,
  routePath,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";

async function chooseUploadMode(page: Page) {
  await page.getByRole("button", { name: /上传文件/ }).click();
}

async function chooseDownloadMode(page: Page) {
  await page.getByRole("button", { name: /下载文件/ }).click();
}

async function fillR2Credentials(page: Page) {
  await page.getByLabel("Account ID").fill("example-account");
  await page.getByLabel("Bucket").fill("demo-bucket");
  await page.getByLabel("Access Key ID").fill("example-access-key");
  await page.getByLabel("Secret Access Key").fill("fake-secret");
  await page.getByLabel("下载链接有效期秒").fill("3600");
}

function r2Code(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    kind: "cloudflare-r2-file-v1",
    accountId: "example-account",
    bucket: "demo-bucket",
    objectKey: "folder/demo.txt",
    presignedUrl: "https://example-account.r2.cloudflarestorage.com/demo-bucket/folder/demo.txt?X-Amz-Signature=fake",
    expiresAt: Date.now() + 3600_000,
    file: { name: "demo.txt", size: 5, type: "text/plain", lastModified: 1 },
    createdAt: Date.now(),
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

  test("opens directly, refreshes in place, marks nav active, and supports history", async ({ page }) => {
    await openRoute(page, "r2");
    await expect(page.getByRole("heading", { name: "R2 传输状态" })).toBeVisible();
    await expect(page.getByText("Cloudflare R2 S3 API", { exact: true })).toBeVisible();
    await expectActiveNav(page, "r2");
    await expectSliderAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.reload();
    await expect(page).toHaveURL(routePath.r2);
    await expectActiveNav(page, "r2");

    await page.getByTestId("nav-item-direct").click();
    await expect(page).toHaveURL(routePath.direct);
    await page.goBack();
    await expect(page).toHaveURL(routePath.r2);
  });

  test("validates upload inputs, signs a mocked PUT, and generates a presigned connection code", async ({ page }) => {
    await page.route("https://example-account.r2.cloudflarestorage.com/**", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("PUT");
      expect(request.url()).toContain("folder/a%20b%2B%E6%B5%8B%E8%AF%95.txt");
      expect(request.url()).not.toContain("fake-secret");
      expect(request.headers().authorization).toContain("Credential=example-access-key/");
      expect(request.headers().authorization).not.toContain("fake-secret");
      await route.fulfill({ status: 200, body: "" });
    });

    await openRoute(page, "r2");
    await chooseUploadMode(page);
    await expect(page.getByRole("button", { name: /上传到 R2/ })).toBeDisabled();
    await fillR2Credentials(page);
    await selectFile(page, "r2-demo.txt");
    await page.getByLabel("对象 Key").fill("folder/a b+测试.txt");
    await page.getByRole("button", { name: /上传到 R2/ }).click();
    await expect(page.getByLabel(/发送方 R2 连接码/)).not.toHaveValue("");
    await expect(page.getByText(/文件已上传到 R2/)).toBeVisible();
    await expect(page.getByText("fake-secret")).toHaveCount(0);
  });

  test("validates TTL boundaries before uploading", async ({ page }) => {
    await openRoute(page, "r2");
    await chooseUploadMode(page);
    await fillR2Credentials(page);
    await selectFile(page, "r2-ttl.txt");
    await page.getByLabel("下载链接有效期秒").fill("0");
    await page.getByRole("button", { name: /上传到 R2/ }).click();
    await expect(page.getByRole("alert")).toContainText("1 到 604800 秒");
  });

  for (const status of [401, 403, 429, 500]) {
    test(`surfaces mocked R2 upload ${status} errors without leaking the secret`, async ({ page }) => {
      await page.route("https://example-account.r2.cloudflarestorage.com/**", async (route) => {
        expect(route.request().url()).not.toContain("fake-secret");
        await route.fulfill({ status, body: `mock ${status}` });
      });
      await openRoute(page, "r2");
      await chooseUploadMode(page);
      await fillR2Credentials(page);
      await selectFile(page, "r2-error.txt");
      await page.getByRole("button", { name: /上传到 R2/ }).click();
      await expect(page.getByText(new RegExp(`HTTP ${status}`))).toBeVisible();
      await expect(page.getByText("fake-secret")).toHaveCount(0);
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

import { expect, test } from "@playwright/test";

import {
  collectConsoleErrors,
  decodeConnectionCodePayload,
  expectNoConsoleErrors,
  installAppMocks,
  selectFile,
} from "./support/app";

const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const probeSha256 = "ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095";

function transferDescriptor(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    kind: "file-transfer-v2",
    createdAt: Date.now(),
    file: {
      id: "123e4567-e89b-42d3-a456-426614174000",
      name: "hello.txt",
      size: 5,
      type: "text/plain",
      lastModified: 1,
      sha256: helloSha256,
    },
    route: {
      kind: "r2",
      objectKey: "users/server/hello.txt",
      downloadUrl: "https://example-account.r2.cloudflarestorage.com/demo-bucket/users/server/hello.txt?X-Amz-Signature=fake",
      expiresAt: Date.now() + 3_600_000,
    },
    ...overrides,
  });
}

function multipathDescriptor(mode: "auto" | "turbo") {
  return JSON.stringify({
    kind: "file-transfer-v3",
    transferId: "123e4567-e89b-42d3-a456-426614174010",
    mode,
    createdAt: Date.now(),
    file: {
      id: "123e4567-e89b-42d3-a456-426614174011",
      name: "hello.txt",
      size: 5,
      type: "text/plain",
      lastModified: 1,
      sha256: helloSha256,
      chunkSize: 48 * 1024,
      totalChunks: 1,
    },
    routes: [{
      kind: "r2",
      objectKey: "users/server/hello.txt",
      downloadUrl: "https://example-account.r2.cloudflarestorage.com/demo-bucket/users/server/hello.txt?X-Amz-Signature=fake",
      expiresAt: Date.now() + 3_600_000,
      probeSize: 5,
      probeSha256,
    }],
  });
}

test.describe("unified file transfer", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(consoleErrors);
  });

  test("generates a multipath pickup before uploading the file body", async ({ page }) => {
    const mocks = await installAppMocks(page, { holdR2Credentials: true });
    await page.goto("/");

    await expect(page.getByTestId("transfer-method-selector")).toHaveCount(0);
    await selectFile(page, "hello.txt", "hello");
    await page.getByRole("button", { name: "生成取件码" }).click();
    await expect(page.getByTestId("pickup-code")).toHaveText("12345678");

    await page.getByRole("button", { name: "复制分享链接" }).click();
    const shareUrl = await page.evaluate(() => window.__appTest.clipboardText);
    expect(shareUrl).toContain("?code=12345678#key=");

    expect(mocks.getPostedVariant()).toBe("multipath");
    expect(mocks.getPostedOffer()).toBe("");
    mocks.releaseR2Credentials();
    await expect.poll(mocks.getPostedOffer).not.toBe("");
    expect(mocks.getUploadedBody()?.toString()).not.toBe("hello");
    expect(mocks.getUploadHeaders().authorization).toContain("Credential=temporary-access-key/");

    const payload = await decodeConnectionCodePayload(page, mocks.getPostedOffer());
    expect(payload.kind).toBe("file-transfer-v4");
    expect(payload.mode).toBe("auto");
    expect(payload.file).toMatchObject({ name: "hello.txt", size: 5, sha256: helloSha256 });
    expect(payload.encryption).toMatchObject({ algorithm: "AES-GCM-256", tagBytes: 16 });
    const routes = payload.routes as Array<Record<string, unknown>>;
    expect(routes).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "r2",
      objectKey: "users/server/demo.txt",
      contentSize: 21,
    })]));
    expect(JSON.stringify(payload)).not.toContain("temporary-secret");
    expect(JSON.stringify(payload)).not.toContain(new URL(shareUrl).hash.slice("#key=".length));
    const downloadUrl = routes.find((route) => route.kind === "r2")?.downloadUrl;
    expect(downloadUrl).toEqual(expect.stringContaining("X-Amz-Signature="));
    expect(downloadUrl).toEqual(expect.stringContaining("X-Amz-Security-Token="));
  });

  test("downloads a protocol-routed file and verifies its hash", async ({ page }) => {
    await installAppMocks(page, { pickupOffer: transferDescriptor(), downloadBody: "hello" });
    await page.goto("/");
    await page.getByTestId("transfer-mode-download").click();
    await page.getByTestId("receiver-code").fill("12345678");
    await page.getByRole("button", { name: "开始接收" }).click();

    await expect(page.getByTestId("download-complete")).toContainText("文件已安全保存");
    await expect(page.getByTestId("receiver-file")).toContainText("hello.txt");
    await expect(page.getByTestId("receiver-file")).toContainText("完成前校验 SHA-256");
    await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(1);
  });

  test("opens a share link and receives as a guest without a login", async ({ page }) => {
    await installAppMocks(page, {
      signedIn: false,
      pickupVariant: "r2",
      pickupOffer: transferDescriptor(),
      downloadBody: "hello",
    });
    await page.goto("/?code=12345678");

    await expect(page.getByText("访客接收已启用，无需注册账号。")).toBeVisible();
    await expect(page.getByTestId("receiver-code")).toHaveValue("12345678");
    await expect(page.getByTestId("receiver-file")).toContainText("hello.txt");
    await page.getByRole("button", { name: "开始接收" }).click();

    await expect(page.getByTestId("download-complete")).toContainText("文件已安全保存");
    await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(1);
  });

  for (const transferMode of ["auto", "turbo"] as const) {
    test(`receives and verifies a v3 ${transferMode} pickup`, async ({ page }) => {
      await installAppMocks(page, {
        pickupVariant: "multipath",
        pickupOffer: multipathDescriptor(transferMode),
        pickupSelection: "r2",
        downloadBody: "hello",
      });
      await page.goto("/");
      await page.getByTestId("transfer-mode-download").click();
      await page.getByTestId("receiver-code").fill("12345678");
      await page.getByRole("button", { name: "开始接收" }).click();

      await expect(page.getByTestId("download-complete")).toContainText("文件已安全保存");
      await expect(page.getByTestId("download-complete")).toContainText("最快线路：R2");
      await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(1);
    });
  }

  test("rejects corrupted content instead of presenting it as complete", async ({ page }) => {
    await installAppMocks(page, { pickupOffer: transferDescriptor(), downloadBody: "HELLO" });
    await page.goto("/");
    await page.getByTestId("transfer-mode-download").click();
    await page.getByTestId("receiver-code").fill("12345678");
    await page.getByRole("button", { name: "开始接收" }).click();

    await expect(page.getByRole("alert")).toContainText("SHA-256 不一致");
    await expect(page.getByTestId("download-complete")).toHaveCount(0);
    await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(0);
  });

  test("cancels in-flight work and ignores stale completion", async ({ page }) => {
    await installAppMocks(page, { r2CredentialDelayMs: 750 });
    await page.goto("/");
    await selectFile(page, "cancel.bin", "cancel me");
    await page.getByRole("button", { name: "生成取件码" }).click();
    await expect(page.getByRole("button", { name: "取消" })).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();

    await expect(page.getByRole("status")).toContainText("传输已取消");
    await expect(page.getByTestId("pickup-code")).toHaveCount(0);
    await selectFile(page, "new.txt", "new");
    await expect(page.getByTestId("selected-file")).toContainText("new.txt");
    await page.waitForTimeout(300);
    await expect(page.getByTestId("pickup-code")).toHaveCount(0);
  });

  test("rejects pickup codes from removed technical flows", async ({ page }) => {
    await installAppMocks(page, { pickupVariant: "turn", pickupOffer: "legacy" });
    await page.goto("/");
    await page.getByTestId("transfer-mode-download").click();
    await page.getByTestId("receiver-code").fill("87654321");

    await expect(page.getByRole("alert")).toContainText("已停用的传输协议");
    await expect(page.getByRole("button", { name: "开始接收" })).toBeDisabled();
  });
});

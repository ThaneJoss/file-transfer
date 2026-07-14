import { expect, test } from "@playwright/test";

import {
  collectConsoleErrors,
  decodeConnectionCodePayload,
  expectNoConsoleErrors,
  installAppMocks,
  selectFile,
} from "./support/app";

const helloSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

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

test.describe("unified file transfer", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(consoleErrors);
  });

  test("uploads a File without exposing technical routes and publishes a v2 protocol", async ({ page }) => {
    const mocks = await installAppMocks(page);
    await page.goto("/");

    await expect(page.getByTestId("transfer-method-selector")).toHaveCount(0);
    await selectFile(page, "hello.txt", "hello");
    await page.getByRole("button", { name: "开始上传" }).click();
    await expect(page.getByTestId("pickup-code")).toHaveText("12345678");

    expect(mocks.getUploadedBody()?.toString()).toBe("hello");
    expect(mocks.getUploadHeaders().authorization).toContain("Credential=temporary-access-key/");
    expect(mocks.getUploadHeaders()["x-amz-content-sha256"]).toBe(helloSha256);

    const payload = await decodeConnectionCodePayload(page, mocks.getPostedOffer());
    expect(payload.kind).toBe("file-transfer-v2");
    expect(payload.file).toMatchObject({ name: "hello.txt", size: 5, sha256: helloSha256 });
    expect(payload.route).toMatchObject({ kind: "r2", objectKey: "users/server/demo.txt" });
    expect(JSON.stringify(payload)).not.toContain("temporary-secret");
    const downloadUrl = (payload.route as Record<string, unknown>).downloadUrl;
    expect(downloadUrl).toEqual(expect.stringContaining("X-Amz-Signature="));
    expect(downloadUrl).toEqual(expect.stringContaining("X-Amz-Security-Token="));
  });

  test("downloads a protocol-routed file and verifies its hash", async ({ page }) => {
    await installAppMocks(page, { pickupOffer: transferDescriptor(), downloadBody: "hello" });
    await page.goto("/");
    await page.getByTestId("transfer-mode-download").click();
    await page.getByTestId("receiver-code").fill("12345678");
    await page.getByRole("button", { name: "读取取件码" }).click();

    await expect(page.getByTestId("receiver-file")).toContainText("hello.txt");
    await expect(page.getByTestId("receiver-file")).toContainText("下载后校验 SHA-256");
    await page.getByRole("button", { name: "保存文件" }).click();

    await expect(page.getByTestId("download-complete")).toContainText("文件已安全保存");
    await expect(page.getByRole("status")).toContainText("SHA-256 校验通过");
    await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(1);
  });

  test("rejects corrupted content instead of presenting it as complete", async ({ page }) => {
    await installAppMocks(page, { pickupOffer: transferDescriptor(), downloadBody: "HELLO" });
    await page.goto("/");
    await page.getByTestId("transfer-mode-download").click();
    await page.getByTestId("receiver-code").fill("12345678");
    await page.getByRole("button", { name: "读取取件码" }).click();
    await page.getByRole("button", { name: "保存文件" }).click();

    await expect(page.getByRole("alert")).toContainText("SHA-256 不一致");
    await expect(page.getByTestId("download-complete")).toHaveCount(0);
    await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(0);
  });

  test("cancels in-flight work and ignores stale completion", async ({ page }) => {
    await installAppMocks(page, { r2CredentialDelayMs: 750 });
    await page.goto("/");
    await selectFile(page, "cancel.bin", "cancel me");
    await page.getByRole("button", { name: "开始上传" }).click();
    await expect(page.getByRole("button", { name: "取消" })).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();

    await expect(page.getByRole("status")).toContainText("上传已取消");
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
    await page.getByRole("button", { name: "读取取件码" }).click();

    await expect(page.getByRole("alert")).toContainText("旧版实时传输");
  });
});

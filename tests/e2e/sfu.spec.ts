import { test, expect, type Page } from "@playwright/test";

import {
  collectConsoleErrors,
  expectNoConsoleErrors,
  installAppMocks,
  openRoute,
  routePath,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";

async function fillSfuCredentials(page: Page) {
  await page.getByLabel("App ID").fill("fake-app-id");
  await page.getByLabel("App Token").fill("test-token");
}

async function mockSfuSuccess(page: Page) {
  let sessionCount = 0;
  await page.route("https://rtc.live.cloudflare.com/v1/apps/fake-app-id/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.headers().authorization).toBe("Bearer test-token");
    expect(request.url()).not.toContain("test-token");

    if (url.pathname.endsWith("/sessions/new")) {
      sessionCount += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessionId: `session-${sessionCount}` }) });
      return;
    }
    if (url.pathname.endsWith("/datachannels/establish")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessionDescription: { type: "answer", sdp: "v=0\r\n" } }),
      });
      return;
    }
    if (url.pathname.endsWith("/datachannels/new")) {
      const body = await request.postDataJSON();
      expect(body.dataChannels?.[0]?.dataChannelName).toBeTruthy();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ dataChannels: [{ id: 7 }] }) });
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  });
}

test.describe("SFU page", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(withoutExpectedNetworkDiagnostics(consoleErrors));
  });

  test("opens directly with SFU transfer controls", async ({ page }) => {
    await openRoute(page, "sfu");
    await expect(page.getByRole("heading", { name: "SFU 连接状态" })).toBeVisible();
    await expect(page.getByText("Cloudflare SFU DataChannel")).toBeVisible();
  });

  test("validates credentials and creates a mocked publisher DataChannel", async ({ page }) => {
    await mockSfuSuccess(page);
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "sfu-demo.txt");
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByRole("alert")).toContainText("App ID");

    await fillSfuCredentials(page);
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByLabel(/发送方 SFU 连接码/)).not.toHaveValue("");
    await expect(page.getByText(/SFU 发布通道已就绪/)).toBeVisible();
    await expect(page.getByText("test-token")).toHaveCount(0);

    await page.getByTestId("nav-item-direct").click();
    await expect(page).toHaveURL(routePath.direct);
    await page.waitForFunction(() => window.__appTest.rtc.closedPeers > 0);
  });

  test("creates a mocked subscriber and rejects malformed connection codes", async ({ page }) => {
    await mockSfuSuccess(page);
    await openRoute(page, "sfu");
    await fillSfuCredentials(page);
    await page.getByRole("button", { name: /接收文件/ }).click();
    await page.getByLabel("发送方 SFU 连接码").fill("not-json");
    await page.getByRole("button", { name: /订阅 DataChannel/ }).click();
    await expect(page.getByRole("alert")).toContainText(/Unexpected token|SFU 连接码格式不正确/);

    const code = {
      kind: "cloudflare-sfu-file-v1",
      publisherSessionId: "publisher-session",
      dataChannelName: "file-test",
      file: { name: "demo.txt", size: 5, type: "text/plain", lastModified: 1 },
      createdAt: Date.now(),
    };
    await page.getByLabel("发送方 SFU 连接码").fill(JSON.stringify(code));
    await page.getByRole("button", { name: /订阅 DataChannel/ }).click();
    await expect(page.getByText(/已订阅 SFU DataChannel/)).toBeVisible();
  });

  for (const status of [401, 403, 429, 500]) {
    test(`surfaces mocked SFU ${status} errors without leaking the token`, async ({ page }) => {
      await page.route("https://rtc.live.cloudflare.com/v1/apps/fake-app-id/**", async (route) => {
        expect(route.request().url()).not.toContain("test-token");
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ errorDescription: `mock ${status}` }),
        });
      });
      await openRoute(page, "sfu");
      await fillSfuCredentials(page);
      await page.getByRole("button", { name: /发送文件/ }).click();
      await selectFile(page, "sfu-error.txt");
      await page.getByRole("button", { name: /创建发布通道/ }).click();
      await expect(page.getByText(`mock ${status}`)).toBeVisible();
      await expect(page.getByText("test-token")).toHaveCount(0);
    });
  }

  test("reports missing API fields and cleans PeerConnection resources on unmount", async ({ page }) => {
    await page.route("https://rtc.live.cloudflare.com/v1/apps/fake-app-id/**", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
    await openRoute(page, "sfu");
    await fillSfuCredentials(page);
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "sfu-missing.txt");
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByText(/没有返回 sessionId/)).toBeVisible();

    await page.getByTestId("nav-item-direct").click();
    await expect(page.evaluate(() => window.__appTest.rtc.closedPeers)).resolves.toBeGreaterThanOrEqual(0);
  });

  test("reports network interruption", async ({ page }) => {
    await page.route("https://rtc.live.cloudflare.com/v1/apps/fake-app-id/**", (route) => route.abort("failed"));
    await openRoute(page, "sfu");
    await fillSfuCredentials(page);
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "sfu-network.txt");
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByText(/Failed to fetch|创建 SFU 发布通道失败/)).toBeVisible();
  });
});

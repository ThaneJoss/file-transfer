import { test, expect, type Page } from "@playwright/test";

import {
  apiBaseUrl,
  collectConsoleErrors,
  decodeConnectionCodePayload,
  expectNoConsoleErrors,
  installAppMocks,
  openRoute,
  rawSignalText,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";

async function mockTurnSuccess(page: Page) {
  await page.route(`${apiBaseUrl}/v1/turn/credentials`, async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers().authorization).toBeUndefined();
    expect(await request.postDataJSON()).toEqual({ ttlSeconds: 3600 });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        iceServers: [
          {
            urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"],
            username: "test-user",
            credential: "temporary-password",
          },
        ],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
  });
}

test.describe("TURN page", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(withoutExpectedNetworkDiagnostics(consoleErrors));
  });

  test("opens directly with TURN transfer controls", async ({ page }) => {
    await openRoute(page, "turn");
    await expect(page.getByText("TURN Relay DataChannel")).toBeVisible();
    await expect(page.getByText("临时 TURN 凭证")).toHaveCount(0);
    await expect(page.getByLabel("TTL 秒")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Probe$/ })).toHaveCount(0);
    await expect(page.getByLabel("Key ID")).toHaveCount(0);
    await expect(page.getByLabel("API Token")).toHaveCount(0);
  });

  test("generates TURN credentials automatically when creating an offer", async ({ page }) => {
    await mockTurnSuccess(page);
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-auto-offer.txt");
    await page.getByRole("button", { name: /生成 TURN Offer/ }).click();
    await expect(page.getByLabel(/发送方 TURN Offer/)).not.toHaveValue("");
  });

  test("applies relay-only TURN config when generating an offer", async ({ page }) => {
    await mockTurnSuccess(page);
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-demo.txt");
    await page.getByRole("button", { name: /生成 TURN Offer/ }).click();
    await expect(page.getByLabel(/发送方 TURN Offer/)).not.toHaveValue("");
    const offer = await decodeConnectionCodePayload(page, await page.getByLabel(/发送方 TURN Offer/).inputValue());
    expect(JSON.stringify(offer)).not.toMatch(/temporary-password|apiToken|TURN Token/i);
    await expect(
      page.evaluate(() => window.__appTest.rtc.createdConfigs.some((config) => config.iceTransportPolicy === "relay")),
    ).resolves.toBe(true);
  });

  test("generates TURN credentials automatically when creating an answer", async ({ page }) => {
    await mockTurnSuccess(page);
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /接收文件/ }).click();
    await page.getByLabel(/发送方 TURN Offer/).fill(
      rawSignalText({
        kind: "turn-webrtc-signal",
        role: "offer",
        descriptionType: "offer",
        candidateTypes: ["relay"],
      }),
    );
    await page.getByRole("button", { name: /生成 TURN Answer/ }).click();
    await expect(page.getByText(/已连接|接收方 TURN Answer/)).toBeVisible();
    await expect(
      page.evaluate(() => window.__appTest.rtc.createdConfigs.some((config) => config.iceTransportPolicy === "relay")),
    ).resolves.toBe(true);
  });

  for (const status of [403, 429, 500]) {
    test(`surfaces mocked TURN ${status} errors`, async ({ page }) => {
      await page.route(`${apiBaseUrl}/v1/turn/credentials`, async (route) => {
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ error: `mock ${status}` }),
        });
      });
      await openRoute(page, "turn");
      await page.getByRole("button", { name: /发送文件/ }).click();
      await selectFile(page, `turn-${status}.txt`);
      await page.getByRole("button", { name: /生成 TURN Offer/ }).click();
      await expect(page.getByRole("alert")).toContainText(`mock ${status}`);
    });
  }

  test("returns to login when the TURN API reports an expired session", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/turn/credentials`, (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-session.txt");
    await page.getByRole("button", { name: /生成 TURN Offer/ }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("alert")).toContainText("登录已过期");
  });

  test("reports network interruption during TURN credential generation", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/turn/credentials`, (route) => route.abort("failed"));
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-network.txt");
    await page.getByRole("button", { name: /生成 TURN Offer/ }).click();
    await expect(page.getByRole("alert")).toContainText(/Failed to fetch|TURN iceServers 生成失败/);
  });
});

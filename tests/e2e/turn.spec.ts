import { test, expect, type Page } from "@playwright/test";

import {
  collectConsoleErrors,
  expectNoConsoleErrors,
  installAppMocks,
  openRoute,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";

async function fillTurnCredentials(page: Page) {
  await page.getByLabel("Key ID").fill("test-key");
  await page.getByLabel("API Token").fill("test-token");
  await page.getByLabel("TTL 秒").fill("3600");
}

async function mockTurnSuccess(page: Page) {
  await page.route("https://rtc.live.cloudflare.com/v1/turn/keys/**", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.url()).not.toContain("test-token");
    expect(request.headers().authorization).toBe("Bearer test-token");
    expect(await request.postDataJSON()).toEqual({ ttl: 3600 });
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
    await expect(page.getByText("Cloudflare TURN Credentials")).toBeVisible();
  });

  test("validates empty credentials and generates mocked TURN iceServers", async ({ page }) => {
    await mockTurnSuccess(page);
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /^生成$/ }).click();
    await expect(page.getByText("请填写 Cloudflare TURN Key ID 和 API Token。")).toBeVisible();

    await fillTurnCredentials(page);
    await page.getByRole("button", { name: /^生成$/ }).click();
    await expect(page.getByText(/已生成 1 组 TURN iceServers/)).toBeVisible();
    await expect(page.getByText("test-token")).toHaveCount(0);
  });

  test("applies relay-only TURN config when generating an offer", async ({ page }) => {
    await mockTurnSuccess(page);
    await openRoute(page, "turn");
    await fillTurnCredentials(page);
    await page.getByRole("button", { name: /^生成$/ }).click();
    await expect(page.getByText(/已生成 1 组 TURN iceServers/)).toBeVisible();

    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-demo.txt");
    await page.getByRole("button", { name: /生成 TURN Offer/ }).click();
    await expect(page.getByLabel(/发送方 TURN Offer/)).not.toHaveValue("");
    await expect(
      page.evaluate(() => window.__appTest.rtc.createdConfigs.some((config) => config.iceTransportPolicy === "relay")),
    ).resolves.toBe(true);
  });

  for (const status of [401, 403, 429, 500]) {
    test(`surfaces mocked TURN ${status} errors without leaking the token`, async ({ page }) => {
      await page.route("https://rtc.live.cloudflare.com/v1/turn/keys/**", async (route) => {
        expect(route.request().url()).not.toContain("test-token");
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ errors: [{ message: `mock ${status}` }] }),
        });
      });
      await openRoute(page, "turn");
      await fillTurnCredentials(page);
      await page.getByRole("button", { name: /^生成$/ }).click();
      await expect(page.getByText(`mock ${status}`)).toBeVisible();
      await expect(page.getByText("test-token")).toHaveCount(0);
    });
  }

  test("reports network interruption during TURN credential generation", async ({ page }) => {
    await page.route("https://rtc.live.cloudflare.com/v1/turn/keys/**", (route) => route.abort("failed"));
    await openRoute(page, "turn");
    await fillTurnCredentials(page);
    await page.getByRole("button", { name: /^生成$/ }).click();
    await expect(page.getByText(/Failed to fetch|TURN iceServers 生成或 probe 失败/)).toBeVisible();
  });
});

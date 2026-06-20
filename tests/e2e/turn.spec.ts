import { test, expect, type Page } from "@playwright/test";

import {
  apiBaseUrl,
  collectConsoleErrors,
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
    const body = await request.postDataJSON();
    expect(body).toEqual(expect.objectContaining({ ttlSeconds: 3600 }));
    if ("fileSizeBytes" in body) expect(body.fileSizeBytes).toBe(16);
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
    await expect(page.getByTestId("sender-pickup-code")).toHaveText("12345678");
  });

  test("refreshes usage after TURN credential generation and file send completion", async ({ page }) => {
    await mockTurnSuccess(page);
    await page.unroute(`${apiBaseUrl}/v1/usage`);
    let usageRequests = 0;
    await page.route(`${apiBaseUrl}/v1/usage`, (route) => {
      usageRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(usageResponse(usageRequests)),
      });
    });

    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-usage.txt");
    await expect(page.getByTestId("sender-pickup-code")).toHaveText("12345678");
    await expect.poll(() => usageRequests).toBeGreaterThanOrEqual(2);
    const afterCredentials = usageRequests;
    await expect(page.getByTestId("header-usage-bars")).toContainText("TURN");

    await page.route(`${apiBaseUrl}/v1/pickups/12345678/answer`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          answer: rawSignalText({
            kind: "turn-webrtc-signal",
            role: "answer",
            descriptionType: "answer",
            candidateTypes: ["relay"],
          }),
        }),
      }),
    );
    await page.waitForFunction(() =>
      window.__appTest.rtc.sentPayloads.some((payload) => payload.kind === "text" && payload.value.includes('"kind":"done"')),
    );
    await expect.poll(() => usageRequests).toBeGreaterThan(afterCredentials);
    await expect(page.getByTestId("header-usage-bars")).toContainText("TURN");
  });

  test("applies relay-only TURN config when generating an offer", async ({ page }) => {
    await mockTurnSuccess(page);
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-demo.txt");
    await expect(page.getByTestId("sender-pickup-code")).toHaveText("12345678");
    await expect(
      page.evaluate(() => window.__appTest.rtc.createdConfigs.some((config) => config.iceTransportPolicy === "relay")),
    ).resolves.toBe(true);
  });

  test("generates TURN credentials automatically when answering from a pickup code", async ({ page }) => {
    await mockTurnSuccess(page);
    let submittedAnswer = "";
    await page.route(`${apiBaseUrl}/v1/pickups/87654321`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "found",
          variant: "turn",
          offer: rawSignalText({
            kind: "turn-webrtc-signal",
            role: "offer",
            descriptionType: "offer",
            candidateTypes: ["relay"],
          }),
          expiresAt: Date.now() + 3600_000,
          answered: false,
        }),
      }),
    );
    await page.route(`${apiBaseUrl}/v1/pickups/87654321/answer`, async (route) => {
      submittedAnswer = (await route.request().postDataJSON() as { answer: string }).answer;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accepted: true }) });
    });
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /接收文件/ }).click();
    await page.getByLabel("8 位取件码").fill("87654321");
    await page.getByRole("button", { name: "取件并连接" }).click();
    await expect.poll(() => submittedAnswer).toMatch(/^[DJ]1\./);
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
      await expect(page.getByRole("alert")).toContainText(`mock ${status}`);
    });
  }

  test("shows the login notice when the TURN API reports an expired session", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/turn/credentials`, (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-session.txt");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "TURN 需要登录" })).toBeVisible();
  });

  test("reports network interruption during TURN credential generation", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/turn/credentials`, (route) => route.abort("failed"));
    await openRoute(page, "turn");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "turn-network.txt");
    await expect(page.getByRole("alert")).toContainText(/Failed to fetch|TURN iceServers 生成失败/);
  });
});

function usageResponse(turnMegabytes: number) {
  const mebibyte = 1024 * 1024;
  return {
    period: {
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-20T04:00:00.000Z",
      timezone: "UTC",
    },
    summary: [
      { service: "turn", bytes: turnMegabytes * mebibyte, quotaBytes: 10 * mebibyte },
      { service: "sfu", bytes: 4 * mebibyte, quotaBytes: 10 * mebibyte },
      { service: "r2", bytes: 3 * mebibyte, quotaBytes: 10 * mebibyte },
    ],
    totalBytes: (turnMegabytes + 7) * mebibyte,
    totalQuotaBytes: 30 * mebibyte,
  };
}

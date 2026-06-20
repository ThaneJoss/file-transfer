import { test, expect } from "@playwright/test";

import {
  apiBaseUrl,
  collectConsoleErrors,
  expectActiveNav,
  expectNoConsoleErrors,
  expectNoHorizontalOverflow,
  expectSliderAligned,
  installAppMocks,
  openRoute,
  rawSignalText,
  routePath,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";

test.describe("Direct page", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(consoleErrors);
  });

  test("opens directly, refreshes in place, marks nav active, and supports history", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "direct");
    await expect(page.getByRole("heading", { name: "连接状态" })).toBeVisible();
    await expectActiveNav(page, "direct");
    await expectSliderAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.reload();
    await expect(page).toHaveURL(routePath.direct);
    await expectActiveNav(page, "direct");

    await page.getByTestId("nav-item-stun").click();
    await expect(page).toHaveURL(routePath.stun);
    await page.goBack();
    await expect(page).toHaveURL(routePath.direct);
    await expectActiveNav(page, "direct");
  });

  test("creates and copies an 8 digit pickup code after file selection", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "direct-demo.txt");
    await expect(page.locator('strong[title="direct-demo.txt"]')).toBeVisible();

    await expect(page.getByTestId("sender-pickup-code")).toHaveText("12345678");
    await page.getByRole("button", { name: "复制取件码" }).click();
    await expect(page.getByRole("status")).toContainText("已复制");

    await page.getByRole("button", { name: /重置/ }).click();
    await expect(page.getByRole("heading", { name: "选择传输目标" })).toBeVisible();
    await expect(page.getByRole("button", { name: /发送文件/ })).toBeVisible();
    await page.getByTestId("nav-item-stun").click();
    await expect(page.evaluate(() => window.__appTest.rtc.closedPeers)).resolves.toBeGreaterThan(0);
  });

  test("requires exactly 8 digits and reports an unknown pickup code", async ({ page }) => {
    await installAppMocks(page);
    await page.route(`${apiBaseUrl}/v1/pickups/87654321`, (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Pickup code not found or expired" }) }),
    );
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /接收文件/ }).click();

    await expect(page.getByRole("button", { name: "取件并连接" })).toBeDisabled();
    await page.getByLabel("8 位取件码").fill("87654321");
    await page.getByRole("button", { name: "取件并连接" }).click();
    await expect(page.getByRole("alert")).toContainText("Pickup code not found or expired");
    consoleErrors = withoutExpectedNetworkDiagnostics(consoleErrors).filter(
      (message) => !message.includes("404 (Not Found)"),
    );
  });

  test("applies a valid answer, sends file metadata/chunk/done messages, and reaches completion", async ({ page }) => {
    await installAppMocks(page);
    let usageBody: unknown;
    await page.route(`${apiBaseUrl}/v1/usage/transfers`, async (route) => {
      usageBody = await route.request().postDataJSON();
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ recorded: true }) });
    });
    await page.route(`${apiBaseUrl}/v1/pickups/12345678/answer`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          answer: rawSignalText({
            kind: "direct-webrtc-signal",
            role: "answer",
            descriptionType: "answer",
            candidateTypes: ["host"],
          }),
        }),
      }),
    );
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "direct-send.txt");
    await expect(page.getByTestId("sender-pickup-code")).toHaveText("12345678");

    await page.waitForFunction(() =>
      window.__appTest.rtc.sentPayloads.some((payload) => payload.kind === "text" && payload.value.includes('"kind":"done"')),
    );
    const payloads = await page.evaluate(() => window.__appTest.rtc.sentPayloads);
    expect(payloads[0]).toMatchObject({ kind: "text" });
    expect((payloads[0] as { value: string }).value).toContain('"name":"direct-send.txt"');
    expect(payloads).toContainEqual({ kind: "arrayBuffer", byteLength: 16 });
    expect(payloads.at(-1)).toMatchObject({ kind: "text" });
    expect((payloads.at(-1) as { value: string }).value).toContain('"kind":"done"');
    expect(usageBody).toMatchObject({ service: "direct", bytes: 16 });
    expect((usageBody as { transferId: string }).transferId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByText("100%").first()).toBeVisible();
  });

  test("retrieves an offer with the pickup code and writes the answer back", async ({ page }) => {
    await installAppMocks(page);
    let submittedAnswer = "";
    await page.route(`${apiBaseUrl}/v1/pickups/12345678/answer`, async (route) => {
      expect(route.request().method()).toBe("PUT");
      submittedAnswer = (await route.request().postDataJSON() as { answer: string }).answer;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accepted: true }) });
    });
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /接收文件/ }).click();
    await page.getByLabel("8 位取件码").fill("12345678");
    await page.getByRole("button", { name: "取件并连接" }).click();

    await expect(page.getByRole("heading", { name: "已连接" })).toBeVisible();
    await expect.poll(() => submittedAnswer).toMatch(/^[DJ]1\./);
  });

  test("reports DataChannel close while applying answer and cleans the pending connection on navigation", async ({ page }) => {
    await installAppMocks(page, { dataChannelState: "connecting", dataChannelFailure: "close" });
    await page.route(`${apiBaseUrl}/v1/pickups/12345678/answer`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          answer: rawSignalText({
            kind: "direct-webrtc-signal",
            role: "answer",
            descriptionType: "answer",
            candidateTypes: ["host"],
          }),
        }),
      }),
    );
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "direct-close.txt");
    await expect(page.getByRole("alert")).toContainText("DataChannel 已关闭");
    await page.getByTestId("nav-item-stun").click();
    await expect(page).toHaveURL(routePath.stun);
    await page.waitForFunction(() => window.__appTest.rtc.closedPeers > 0);
    await page.waitForFunction(() => window.__appTest.rtc.closedChannels > 0);
  });

  test("keeps pickup codes unavailable to signed-out users", async ({ page }) => {
    await installAppMocks(page);
    await page.unroute(`${apiBaseUrl}/api/auth/get-session`);
    await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) =>
      route.fulfill({ contentType: "application/json", body: "null" }),
    );
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "guest.txt");
    await expect(page.getByTestId("sender-pickup-code")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /生成 Offer/ })).toBeVisible();
  });
});

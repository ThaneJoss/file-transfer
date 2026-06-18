import { test, expect } from "@playwright/test";

import {
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

  test("covers sender mode, file selection, offer generation, copy, reset and cleanup", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "direct-demo.txt");
    await expect(page.locator('strong[title="direct-demo.txt"]')).toBeVisible();

    await page.getByRole("button", { name: /生成 Offer/ }).click();
    const offer = page.getByLabel(/发送方 Offer/);
    await expect(offer).not.toHaveValue("");

    await page.getByRole("button", { name: /复制 Offer/ }).click();
    await expect(page.getByLabel(/接收方 Answer/)).toBeVisible();

    await page.getByRole("button", { name: /重置/ }).click();
    await expect(page.getByRole("heading", { name: "选择传输目标" })).toBeVisible();
    await expect(page.getByRole("button", { name: /发送文件/ })).toBeVisible();
    await page.getByTestId("nav-item-stun").click();
    await expect(page.evaluate(() => window.__appTest.rtc.closedPeers)).resolves.toBeGreaterThan(0);
  });

  test("covers receiver mode, invalid connection code, empty input, and answer generation", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /接收文件/ }).click();

    await expect(page.getByRole("button", { name: /生成 Answer/ })).toBeDisabled();
    await page.getByLabel(/发送方 Offer/).fill("not-json");
    await page.getByRole("button", { name: /生成 Answer/ }).click();
    await expect(page.getByRole("alert")).toContainText(/Unexpected token|连接文本格式不正确/);
  });

  test("applies a valid answer, sends file metadata/chunk/done messages, and reaches completion", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "direct-send.txt");
    await page.getByRole("button", { name: /生成 Offer/ }).click();
    await expect(page.getByLabel(/发送方 Offer/)).not.toHaveValue("");

    await page.getByRole("button", { name: /复制 Offer/ }).click();
    await page.getByLabel(/接收方 Answer/).fill(
      rawSignalText({
        kind: "direct-webrtc-signal",
        role: "answer",
        descriptionType: "answer",
        candidateTypes: ["host"],
      }),
    );
    await page.getByRole("button", { name: "发送" }).click();

    await page.waitForFunction(() =>
      window.__appTest.rtc.sentPayloads.some((payload) => payload.kind === "text" && payload.value.includes('"kind":"done"')),
    );
    const payloads = await page.evaluate(() => window.__appTest.rtc.sentPayloads);
    expect(payloads[0]).toMatchObject({ kind: "text" });
    expect((payloads[0] as { value: string }).value).toContain('"name":"direct-send.txt"');
    expect(payloads).toContainEqual({ kind: "arrayBuffer", byteLength: 16 });
    expect(payloads.at(-1)).toMatchObject({ kind: "text" });
    expect((payloads.at(-1) as { value: string }).value).toContain('"kind":"done"');
    await expect(page.getByText("100%").first()).toBeVisible();
  });

  test("reports DataChannel close while applying answer and cleans the pending connection on navigation", async ({ page }) => {
    await installAppMocks(page, { dataChannelState: "connecting", dataChannelFailure: "close" });
    await openRoute(page, "direct");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "direct-close.txt");
    await page.getByRole("button", { name: /生成 Offer/ }).click();
    await page.getByRole("button", { name: /复制 Offer/ }).click();
    await page.getByLabel(/接收方 Answer/).fill(
      rawSignalText({
        kind: "direct-webrtc-signal",
        role: "answer",
        descriptionType: "answer",
        candidateTypes: ["host"],
      }),
    );
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.getByRole("alert")).toContainText("DataChannel 已关闭");
    await page.getByTestId("nav-item-stun").click();
    await expect(page).toHaveURL(routePath.stun);
    await page.waitForFunction(() => window.__appTest.rtc.closedPeers > 0);
    await page.waitForFunction(() => window.__appTest.rtc.closedChannels > 0);
  });
});

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

test.describe("STUN page", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(consoleErrors);
  });

  test("opens directly, refreshes in place, marks nav active, and supports history", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "stun");
    await expect(page.getByText("STUN DataChannel")).toBeVisible();
    await expect(page.getByText(/stun.cloudflare.com:3478/)).toBeVisible();
    await expectActiveNav(page, "stun");
    await expectSliderAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.reload();
    await expect(page).toHaveURL(routePath.stun);
    await expectActiveNav(page, "stun");

    await page.getByTestId("nav-item-direct").click();
    await expect(page).toHaveURL(routePath.direct);
    await page.goBack();
    await expect(page).toHaveURL(routePath.stun);
  });

  test("uses STUN candidates for sender offer generation and cleans resources on unmount", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "stun-demo.txt");
    await page.getByRole("button", { name: /生成 STUN Offer/ }).click();
    await expect(page.getByLabel(/发送方 STUN Offer/)).not.toHaveValue("");
    await expect(page.getByText(/已收集 srflx|srflx 1/).first()).toBeVisible();

    await page.getByTestId("nav-item-direct").click();
    await expect(page.evaluate(() => window.__appTest.rtc.closedPeers)).resolves.toBeGreaterThan(0);
  });

  test("reports no usable STUN candidate when the browser only returns host candidates", async ({ page }) => {
    await installAppMocks(page, { candidateTypes: ["host"] });
    await openRoute(page, "stun");
    await expect(page.getByText(/没有收集到 srflx|未得到 srflx|probe 失败/).first()).toBeVisible();
  });

  test("rejects invalid STUN offer input in receiver mode", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /接收文件/ }).click();
    await expect(page.getByRole("button", { name: /生成 STUN Answer/ })).toBeDisabled();
    await page.getByLabel(/发送方 STUN Offer/).fill('{"kind":"direct-webrtc-signal"}');
    await page.getByRole("button", { name: /生成 STUN Answer/ }).click();
    await expect(page.getByRole("alert")).toContainText(/连接文本格式不正确|不是 STUN Offer|不是 Offer/);
  });

  test("rejects host-only STUN answers before applying them to the sender", async ({ page }) => {
    await installAppMocks(page);
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "stun-host-only.txt");
    await page.getByRole("button", { name: /生成 STUN Offer/ }).click();
    await expect(page.getByLabel(/发送方 STUN Offer/)).not.toHaveValue("");

    await page.getByRole("button", { name: /复制 STUN Offer/ }).click();
    await page.getByLabel(/接收方 STUN Answer/).fill(
      rawSignalText({
        kind: "stun-webrtc-signal",
        role: "answer",
        descriptionType: "answer",
        candidateTypes: ["host"],
      }),
    );
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.getByRole("alert")).toContainText(/没有可用于连接的 srflx\/relay 候选|建立 STUN 连接失败/);
  });

  test("reports STUN DataChannel errors during connection establishment", async ({ page }) => {
    await installAppMocks(page, { dataChannelState: "connecting", dataChannelFailure: "error" });
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "stun-channel-error.txt");
    await page.getByRole("button", { name: /生成 STUN Offer/ }).click();
    await page.getByRole("button", { name: /复制 STUN Offer/ }).click();
    await page.getByLabel(/接收方 STUN Answer/).fill(
      rawSignalText({
        kind: "stun-webrtc-signal",
        role: "answer",
        descriptionType: "answer",
        candidateTypes: ["srflx"],
      }),
    );
    await page.getByRole("button", { name: "发送" }).click();

    await expect(page.getByRole("alert")).toContainText("DataChannel 发生错误");
    await page.getByTestId("nav-item-direct").click();
    await expect(page.evaluate(() => window.__appTest.rtc.closedPeers)).resolves.toBeGreaterThan(0);
  });
});

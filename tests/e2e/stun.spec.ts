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
    await expect(page.getByText("STUN DataChannel", { exact: true })).toBeVisible();
    await expect(page.getByText(/stun.cloudflare.com:3478/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Probe$/ })).toHaveCount(0);
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
    await expect(page.getByTestId("sender-pickup-code")).toHaveText("12345678");
    await expect(page.getByText(/已收集 srflx|srflx 1/).first()).toBeVisible();

    await page.getByTestId("nav-item-direct").click();
    await page.waitForFunction(() => window.__appTest.rtc.closedPeers > 0);
  });

  test("reports no usable STUN candidate when the browser only returns host candidates", async ({ page }) => {
    await installAppMocks(page, { candidateTypes: ["host"] });
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "stun-host-only.txt");
    await expect(page.getByRole("alert")).toContainText(/没有收集到 srflx|未得到 srflx|没有包含 ICE candidate/);
  });

  test("rejects a Direct pickup code on the STUN page", async ({ page }) => {
    await installAppMocks(page);
    await page.route(`${apiBaseUrl}/v1/pickups/87654321`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "found",
          variant: "direct",
          offer: rawSignalText({
            kind: "direct-webrtc-signal",
            role: "offer",
            descriptionType: "offer",
            candidateTypes: ["host"],
          }),
          expiresAt: Date.now() + 3600_000,
          answered: false,
        }),
      }),
    );
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /接收文件/ }).click();
    await page.getByLabel("8 位取件码").fill("87654321");
    await page.getByRole("button", { name: "取件并连接" }).click();
    await expect(page.getByRole("alert")).toContainText("该取件码属于 DIRECT");
  });

  test("rejects host-only STUN answers before applying them to the sender", async ({ page }) => {
    await installAppMocks(page);
    await page.route(`${apiBaseUrl}/v1/pickups/12345678/answer`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          answer: rawSignalText({
            kind: "stun-webrtc-signal",
            role: "answer",
            descriptionType: "answer",
            candidateTypes: ["host"],
          }),
        }),
      }),
    );
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "stun-host-only.txt");
    await expect(page.getByRole("alert")).toContainText(/没有可用于连接的 srflx\/relay 候选|建立 STUN 连接失败/);
  });

  test("reports STUN DataChannel errors during connection establishment", async ({ page }) => {
    await installAppMocks(page, { dataChannelState: "connecting", dataChannelFailure: "error" });
    await page.route(`${apiBaseUrl}/v1/pickups/12345678/answer`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          answer: rawSignalText({
            kind: "stun-webrtc-signal",
            role: "answer",
            descriptionType: "answer",
            candidateTypes: ["srflx"],
          }),
        }),
      }),
    );
    await openRoute(page, "stun");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "stun-channel-error.txt");
    await expect(page.getByRole("alert")).toContainText("DataChannel 发生错误");
    await page.getByTestId("nav-item-direct").click();
    await page.waitForFunction(() => window.__appTest.rtc.closedPeers > 0);
  });
});

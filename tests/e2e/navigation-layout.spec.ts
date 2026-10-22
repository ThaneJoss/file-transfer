import { expect, test } from "./support/test";

import {
  collectConsoleErrors,
  expectNoConsoleErrors,
  expectNoHorizontalOverflow,
  installAppMocks,
} from "./support/app";

test("supports skipping navigation and manually activating transfer tabs with the keyboard", async ({ page }) => {
  await installAppMocks(page);
  await page.goto("/");
  const upload = page.getByRole("tab", { name: /上传文件/ });
  const download = page.getByRole("tab", { name: /下载文件/ });
  const panel = page.getByRole("tabpanel");
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("page-slot")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(upload).toBeFocused();
  await expect(upload).toHaveCSS("outline-color", "rgb(255, 255, 255)");
  await expect(upload).toHaveCSS("outline-width", "3px");
  await expect(page.locator(".transfer-mode-switch__indicator")).toHaveCSS("background-color", "rgb(37, 99, 235)");
  await expect(download).toHaveAttribute("tabindex", "-1");

  // Moving focus must not change direction: doing so cancels active transfers.
  await page.keyboard.press("ArrowRight");
  await expect(download).toBeFocused();
  await expect(download).toHaveCSS("outline-color", "rgb(37, 99, 235)");
  await expect(upload).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("upload-dropzone")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(download).toHaveAttribute("aria-selected", "true");
  await expect(download).toBeFocused();
  await expect(download).toHaveCSS("outline-color", "rgb(255, 255, 255)");
  await expect(panel).toHaveAccessibleName(/下载文件/);
  await expect(page.getByTestId("receiver-code")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(panel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(download).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(upload).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(download).toBeFocused();
  await page.keyboard.press("Home");
  await expect(upload).toBeFocused();
  await page.keyboard.press("End");
  await expect(download).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await expect(upload).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAccessibleName(/上传文件/);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`keeps the primary upload and download actions usable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
    await page.goto("/");

    await expect(page.getByTestId("unified-transfer-page")).toBeVisible();
    await expect(page.getByTestId("transfer-mode-upload")).toBeVisible();
    // A 320px phone needs vertical scrolling; controls must remain reachable
    // without shrinking text or requiring horizontal scrolling.
    if (viewport.width === 320) await page.getByTestId("upload-dropzone").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("upload-dropzone")).toBeInViewport();
    await expect(page.getByTestId("transfer-method-selector")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await testInfo.attach(`upload-${viewport.width}px`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.getByTestId("transfer-mode-download").click();
    await expect(page.getByTestId("receiver-code")).toBeVisible();
    if (viewport.width === 320) await page.getByTestId("receiver-code").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("receiver-code")).toBeInViewport();
    const codeBox = await page.getByTestId("receiver-code").boundingBox();
    expect(codeBox).not.toBeNull();
    expect(codeBox!.x).toBeGreaterThanOrEqual(0);
    expect(codeBox!.x + codeBox!.width).toBeLessThanOrEqual(viewport.width);
    await expectNoHorizontalOverflow(page);
    await expectNoConsoleErrors(consoleErrors);
    await testInfo.attach(`download-${viewport.width}px`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

test("fits the complete signed-in homepage in a 1080p desktop browser window", async ({ page }) => {
  // A maximized browser on a 1920x1080 display leaves roughly 900 CSS pixels
  // after the tab strip, toolbar, and operating-system chrome are accounted for.
  await page.setViewportSize({ width: 1920, height: 900 });
  const consoleErrors = collectConsoleErrors(page);
  await installAppMocks(page);
  await page.goto("/");

  const homepage = page.getByTestId("unified-transfer-page");
  await expect(homepage).toBeVisible();
  await expect(page.getByTestId("upload-dropzone")).toBeInViewport();

  const pageSlotMetrics = await page.getByTestId("page-slot").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(pageSlotMetrics.scrollTop).toBe(0);
  expect(pageSlotMetrics.scrollHeight).toBeLessThanOrEqual(pageSlotMetrics.clientHeight + 1);

  const homepageBox = await homepage.boundingBox();
  expect(homepageBox).not.toBeNull();
  expect(homepageBox!.y + homepageBox!.height).toBeLessThanOrEqual(901);
  await expectNoHorizontalOverflow(page);
  await expectNoConsoleErrors(consoleErrors);
});

test("fits the logged-out homepage on a scaled 1080p Windows display", async ({ page }) => {
  // Windows at 125% display scaling turns a physical 1920x1080 screen into an
  // approximately 1536x690 CSS viewport after Chrome and the taskbar.
  await page.setViewportSize({ width: 1536, height: 690 });
  const consoleErrors = collectConsoleErrors(page);
  await installAppMocks(page, { signedIn: false });
  await page.route("https://api.file.thanejoss.com/api/auth/get-session", (route) => route.abort("failed"));
  await page.goto("/");

  const homepage = page.getByTestId("unified-transfer-page");
  await expect(page.getByTestId("transfer-login-required")).toBeVisible();
  await expect(page.getByText("暂时无法确认登录状态，请检查网络后重试。")).toBeVisible();

  const pageSlotMetrics = await page.getByTestId("page-slot").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  expect(pageSlotMetrics.scrollTop).toBe(0);
  expect(pageSlotMetrics.scrollHeight).toBeLessThanOrEqual(pageSlotMetrics.clientHeight + 1);

  const homepageBox = await homepage.boundingBox();
  expect(homepageBox).not.toBeNull();
  expect(homepageBox!.y + homepageBox!.height).toBeLessThanOrEqual(691);
  await expectNoHorizontalOverflow(page);
  expect(consoleErrors).toHaveLength(1);
  expect(consoleErrors[0]).toContain("net::ERR_FAILED");
});

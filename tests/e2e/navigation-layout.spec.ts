import { expect, test } from "@playwright/test";

import {
  collectConsoleErrors,
  expectNoConsoleErrors,
  expectNoHorizontalOverflow,
  installAppMocks,
} from "./support/app";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`keeps the primary upload and download actions usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
    await page.goto("/");

    await expect(page.getByTestId("unified-transfer-page")).toBeVisible();
    await expect(page.getByTestId("transfer-mode-upload")).toBeVisible();
    await expect(page.getByTestId("upload-dropzone")).toBeInViewport();
    await expect(page.getByTestId("transfer-method-selector")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("transfer-mode-download").click();
    await expect(page.getByTestId("receiver-code")).toBeVisible();
    await expect(page.getByTestId("receiver-code")).toBeInViewport();
    const codeBox = await page.getByTestId("receiver-code").boundingBox();
    expect(codeBox).not.toBeNull();
    expect(codeBox!.x).toBeGreaterThanOrEqual(0);
    expect(codeBox!.x + codeBox!.width).toBeLessThanOrEqual(viewport.width);
    await expectNoHorizontalOverflow(page);
    await expectNoConsoleErrors(consoleErrors);
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
  await expect(page.getByText("Failed to fetch")).toBeVisible();

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
  await expectNoConsoleErrors(consoleErrors);
});

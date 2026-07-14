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

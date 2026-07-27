import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { installAppMocks, installWebAuthnMocks } from "./support/app";

const scenarios = [
  { name: "访客首页", path: "/", signedIn: false, ready: "unified-transfer-page" },
  { name: "登录态首页", path: "/", signedIn: true, ready: "upload-dropzone" },
  { name: "Passkey 登录页", path: "/login", signedIn: false, ready: "login-page" },
  { name: "账户与用量页", path: "/account", signedIn: true, ready: "user-usage-page" },
] as const;

for (const scenario of scenarios) {
  test(`${scenario.name}没有自动检测到的无障碍违规`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installWebAuthnMocks(page);
    await installAppMocks(page, { signedIn: scenario.signedIn });
    await page.goto(scenario.path);
    await expect(page.getByTestId(scenario.ready)).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
]) {
  test(`登录态首页在 ${viewport.width}px 宽度没有自动检测到的无障碍违规`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installAppMocks(page);
    await page.goto("/");
    await expect(page.getByTestId("upload-dropzone")).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

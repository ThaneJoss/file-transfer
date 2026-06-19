import { expect, test } from "@playwright/test";

import { apiBaseUrl, installAppMocks, testAuthSession } from "./support/app";

test.describe("authentication", () => {
  test("redirects protected pages and signs in with email and password", async ({ page }) => {
    await installAppMocks(page);
    await page.unroute(`${apiBaseUrl}/api/auth/get-session`);
    let authenticated = false;
    await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(authenticated ? testAuthSession() : null),
      }),
    );
    await page.route(`${apiBaseUrl}/api/auth/sign-in/email`, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(await request.postDataJSON()).toMatchObject({ email: "user@example.com", password: "password123" });
      authenticated = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ redirect: false, token: "cookie-session-token", url: null, user: testAuthSession().user }),
      });
    });
    await page.unroute(`${apiBaseUrl}/api/auth/sign-out`);
    await page.route(`${apiBaseUrl}/api/auth/sign-out`, async (route) => {
      authenticated = false;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) });
    });

    await page.goto("/turn");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
    await page.getByLabel("Email").fill("user@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "登录", exact: true }).click();

    await expect(page).toHaveURL(/\/turn$/);
    await expect(page.getByText("TURN Relay DataChannel")).toBeVisible();
    await expect(page.getByTestId("account-area")).toContainText("测试用户");
    await expect(page.getByLabel("用量事件")).toContainText("TURN 2 · R2 3 · SFU 4");

    await page.getByLabel("退出登录").click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shows the registration name field", async ({ page }) => {
    await installAppMocks(page);
    await page.unroute(`${apiBaseUrl}/api/auth/get-session`);
    await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) => route.fulfill({ contentType: "application/json", body: "null" }));
    await page.goto("/login");
    await page.getByRole("button", { name: "切换到注册" }).click();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });
});

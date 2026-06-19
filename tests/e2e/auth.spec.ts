import { expect, test } from "@playwright/test";

import { apiBaseUrl, installAppMocks, installWebAuthnMocks, testAuthSession } from "./support/app";

test.describe("authentication", () => {
  test("redirects protected pages and signs in with passkey", async ({ page }) => {
    await installAppMocks(page);
    await installWebAuthnMocks(page);
    await page.unroute(`${apiBaseUrl}/api/auth/get-session`);
    let authenticated = false;
    await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(authenticated ? testAuthSession() : null),
      }),
    );
    await page.route(`${apiBaseUrl}/api/auth/passkey/generate-authenticate-options`, (route) => {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          challenge: "YXV0aG4tY2hhbGxlbmdl",
          rpId: "file.thanejoss.com",
          userVerification: "preferred",
          allowCredentials: [],
        }),
      });
    });
    await page.route(`${apiBaseUrl}/api/auth/passkey/verify-authentication`, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(await request.postDataJSON()).toMatchObject({
        response: {
          id: "mock-passkey-id",
          type: "public-key",
        },
      });
      authenticated = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(testAuthSession()),
      });
    });
    await page.unroute(`${apiBaseUrl}/api/auth/sign-out`);
    await page.route(`${apiBaseUrl}/api/auth/sign-out`, async (route) => {
      authenticated = false;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) });
    });

    await page.goto("/turn");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Passkey 登录" })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await page.getByRole("button", { name: "使用 Passkey 登录" }).click();

    await expect(page).toHaveURL(/\/turn$/);
    await expect(page.getByText("TURN Relay DataChannel")).toBeVisible();
    await expect(page.getByTestId("account-area")).toContainText("测试用户");
    await expect(page.getByLabel("用量事件")).toContainText("TURN 2 · R2 3 · SFU 4");

    await page.getByLabel("退出登录").click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("registers with passkey registration context", async ({ page }) => {
    await installAppMocks(page);
    await installWebAuthnMocks(page);
    await page.unroute(`${apiBaseUrl}/api/auth/get-session`);
    let authenticated = false;
    await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(authenticated ? testAuthSession() : null),
      }),
    );
    await page.route(`${apiBaseUrl}/v1/passkey/registration-context`, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(await request.postDataJSON()).toEqual({ name: "测试用户" });
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ context: "signed-context" }) });
    });
    await page.route(apiRoutePattern("/api/auth/passkey/generate-register-options"), (route) => {
      const url = new URL(route.request().url());
      expect(route.request().method()).toBe("GET");
      expect(url.searchParams.get("name")).toBe("测试用户");
      expect(url.searchParams.get("context")).toBe("signed-context");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          challenge: "cmVnaXN0ZXItY2hhbGxlbmdl",
          rp: { name: "文件中转站", id: "file.thanejoss.com" },
          user: { id: "dXNlci10ZXN0", name: "测试用户", displayName: "测试用户" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 60_000,
          attestation: "none",
          authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        }),
      });
    });
    await page.route(`${apiBaseUrl}/api/auth/passkey/verify-registration`, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(await request.postDataJSON()).toMatchObject({
        name: "测试用户",
        response: {
          id: "mock-passkey-id",
          type: "public-key",
        },
      });
      authenticated = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "passkey-1",
          name: "测试用户",
          userId: "user-test",
          credentialID: "mock-passkey-id",
          createdAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/login");
    await page.getByRole("button", { name: "切换到注册" }).click();
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await page.getByLabel("Name").fill("测试用户");
    await page.getByRole("button", { name: "创建 Passkey 并登录" }).click();

    await expect(page).toHaveURL(/\/turn$/);
    await expect(page.getByTestId("account-area")).toContainText("测试用户");
  });
});

function apiRoutePattern(path: string) {
  const escapedBaseUrl = apiBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedBaseUrl}${path}(?:\\?.*)?$`);
}

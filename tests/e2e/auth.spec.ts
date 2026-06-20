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
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("app-shell")).toHaveCount(0);
    await expect(page.getByTestId("app-nav")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Passkey 登录" })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
    await page.getByRole("button", { name: "使用 Passkey 登录" }).click();

    await expect(page).toHaveURL(/\/turn$/);
    await expect(page.getByText("TURN Relay DataChannel")).toBeVisible();
    await expect(page.getByTestId("account-area")).toContainText("测试用户");
    await expect(page.getByLabel("本月流量")).toContainText("TURN 2.00 MB · SFU 4.00 MB · R2 3.00 MB");

    await page.getByLabel("退出登录").click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("shows the signed-in user's monthly traffic usage", async ({ page }) => {
    await installAppMocks(page);

    await page.goto("/account");

    await expect(page.getByTestId("user-usage-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "用户用量" })).toBeVisible();
    await expect(page.getByTestId("user-usage-page")).toContainText("测试用户");
    await expect(page.getByText("本月总流量")).toBeVisible();
    await expect(page.getByText("9.00 MB")).toBeVisible();
    await expect(page.getByTestId("usage-card-turn")).toContainText("2.00 MB");
    await expect(page.getByTestId("usage-card-sfu")).toContainText("4.00 MB");
    await expect(page.getByTestId("usage-card-r2")).toContainText("3.00 MB");
  });

  test("refreshes usage when entering the account page and clicking refresh", async ({ page }) => {
    await installAppMocks(page);
    await page.unroute(`${apiBaseUrl}/v1/usage`);
    let usageRequests = 0;
    await page.route(`${apiBaseUrl}/v1/usage`, (route) => {
      usageRequests += 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(usageResponse(usageRequests)),
      });
    });

    await page.goto("/account");
    await expect(page.getByTestId("user-usage-page")).toBeVisible();
    await expect.poll(() => usageRequests).toBeGreaterThanOrEqual(2);
    const enteredVersion = usageRequests;
    await expect(page.getByTestId("usage-card-turn")).toContainText(usageMbLabel(enteredVersion));

    await page.getByRole("button", { name: /^刷新$/ }).click();
    await expect.poll(() => usageRequests).toBeGreaterThan(enteredVersion);
    const refreshedVersion = usageRequests;
    await expect(page.getByTestId("usage-card-turn")).toContainText(usageMbLabel(refreshedVersion));
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

function usageResponse(turnMegabytes: number) {
  const mebibyte = 1024 * 1024;
  return {
    period: {
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-06-20T04:00:00.000Z",
      timezone: "UTC",
    },
    summary: [
      { service: "turn", bytes: turnMegabytes * mebibyte, quotaBytes: 10 * mebibyte },
      { service: "sfu", bytes: 4 * mebibyte, quotaBytes: 10 * mebibyte },
      { service: "r2", bytes: 3 * mebibyte, quotaBytes: 10 * mebibyte },
    ],
    totalBytes: (turnMegabytes + 7) * mebibyte,
    totalQuotaBytes: 30 * mebibyte,
  };
}

function usageMbLabel(megabytes: number) {
  return `${megabytes.toFixed(2)} MB`;
}

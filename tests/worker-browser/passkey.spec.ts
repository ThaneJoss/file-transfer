import { expect, test } from "@playwright/test";

test("real passkey registration and login preserve D1 sessions", async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("The local Worker baseURL is required");
  const origin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin) return route.continue();
    externalRequests.push(`${request.method()} ${request.url()}`);
    return route.abort("blockedbyclient");
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  try {
    await page.goto("/login");
    await page.getByRole("button", { name: "切换到注册" }).click();
    const name = "Local Passkey Regression";
    await page.getByLabel("Name", { exact: true }).fill(name);

    const registrationContext = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v1/passkey/registration-context",
    );
    const registration = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/auth/passkey/verify-registration",
    );
    await page.getByRole("button", { name: "创建 Passkey 并登录" }).click();
    const registrationResponse = await registration;
    expect(registrationResponse.status(), await registrationResponse.text()).toBe(200);
    await expect(page.getByTestId("account-area")).toContainText(name);
    await expect(page).toHaveURL(`${origin}/`);

    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0].rpId).toBe("localhost");
    const sessionResponse = await context.request.get(`${origin}/api/auth/get-session`);
    expect(sessionResponse.status()).toBe(200);
    const registeredSession = await sessionResponse.json();
    expect(registeredSession.user.name).toBe(name);
    expect(registeredSession.session.userId).toBe(registeredSession.user.id);
    expect((await context.cookies()).some((cookie) =>
      cookie.name.includes("session_token") && cookie.httpOnly,
    )).toBe(true);

    // Reload forces a fresh browser session lookup against the stored D1 rows.
    await page.reload();
    await expect(page.getByTestId("account-area")).toContainText(name);
    const me = await context.request.get(`${origin}/v1/me`);
    expect(me.status()).toBe(200);
    expect((await me.json()).user.id).toBe(registeredSession.user.id);

    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByTestId("account-area").getByRole("link", { name: "登录", exact: true })).toBeVisible();
    expect(await (await context.request.get(`${origin}/api/auth/get-session`)).json()).toBeNull();
    expect((await context.request.get(`${origin}/v1/me`)).status()).toBe(401);

    const issuedContext = (await (await registrationContext).json()).context as string;
    const replay = await context.request.get(
      `${origin}/api/auth/passkey/generate-register-options?context=${encodeURIComponent(issuedContext)}`,
    );
    expect(replay.status()).toBe(400);

    await page.goto("/login");
    const authentication = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/auth/passkey/verify-authentication",
    );
    await page.getByRole("button", { name: "使用 Passkey 登录" }).click();
    const authenticationResponse = await authentication;
    expect(authenticationResponse.status(), await authenticationResponse.text()).toBe(200);
    await expect(page.getByTestId("account-area")).toContainText(name);
    const signedInSession = await (await context.request.get(`${origin}/api/auth/get-session`)).json();
    expect(signedInSession.user.id).toBe(registeredSession.user.id);
    expect(signedInSession.session.id).not.toBe(registeredSession.session.id);
    expect((await context.request.get(`${origin}/v1/me`)).status()).toBe(200);

    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.detach();
  }
});

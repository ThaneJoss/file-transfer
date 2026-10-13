import { expect, test as base } from "@playwright/test";

// Registered before each test's mocks: known API routes are fulfilled by those
// mocks; anything else must stay on the local app server.
export const test = base.extend<{ externalRequests: string[] }>({
  externalRequests: [async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error("E2E requires a local app baseURL");
    const appOrigin = new URL(baseURL).origin;
    const requests: string[] = [];

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === appOrigin) return route.continue();

      requests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    });

    await use(requests);
    expect(requests, "Unmocked external requests must never reach live services").toEqual([]);
  }, { auto: true }],
});

export { expect };

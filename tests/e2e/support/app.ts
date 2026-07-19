import { expect, type BrowserContext, type Page } from "@playwright/test";

export const apiBaseUrl = "https://api.file.thanejoss.com";
export const r2Origin = "https://example-account.r2.cloudflarestorage.com";

export function testAuthSession() {
  return {
    session: {
      id: "session-test",
      userId: "user-test",
      token: "cookie-session-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    user: {
      id: "user-test",
      name: "测试用户",
      email: "user@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function installWebAuthnMocks(page: Page) {
  await page.addInitScript(() => {
    const encoder = new TextEncoder();
    const bytes = (value: string) => encoder.encode(value).buffer;

    class MockPublicKeyCredential {}
    Object.defineProperty(MockPublicKeyCredential, "isConditionalMediationAvailable", { value: async () => false });
    Object.defineProperty(MockPublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", { value: async () => true });
    Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: MockPublicKeyCredential });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => ({
          id: "mock-passkey-id",
          rawId: bytes("mock-passkey-raw-id"),
          type: "public-key",
          authenticatorAttachment: "platform",
          response: {
            attestationObject: bytes("mock-attestation"),
            clientDataJSON: bytes("mock-client-data"),
            getTransports: () => ["internal"],
            getPublicKeyAlgorithm: () => -7,
            getPublicKey: () => bytes("mock-public-key"),
            getAuthenticatorData: () => bytes("mock-authenticator-data"),
          },
          getClientExtensionResults: () => ({}),
        }),
        get: async () => ({
          id: "mock-passkey-id",
          rawId: bytes("mock-passkey-raw-id"),
          type: "public-key",
          authenticatorAttachment: "platform",
          response: {
            authenticatorData: bytes("mock-authenticator-data"),
            clientDataJSON: bytes("mock-client-data"),
            signature: bytes("mock-signature"),
            userHandle: bytes("user-test"),
          },
          getClientExtensionResults: () => ({}),
        }),
      },
    });
  });
}

export type AppMockOptions = {
  signedIn?: boolean;
  pickupOffer?: string;
  pickupVariant?: "direct" | "stun" | "turn" | "sfu" | "r2" | "multipath";
  downloadBody?: string | Uint8Array;
  r2FailureStatus?: number;
  r2CredentialDelayMs?: number;
  holdR2Credentials?: boolean;
  disableRealtime?: boolean;
  pickupSelection?: "direct" | "stun" | "turn" | "sfu" | "r2";
};

export async function installAppMocks(page: Page, options: AppMockOptions = {}) {
  let postedOffer = "";
  let uploadedBody: Buffer | null = null;
  let uploadHeaders: Record<string, string> = {};
  let postedVariant = "";
  let releaseR2Credentials: () => void = () => undefined;
  const r2CredentialGate = new Promise<void>((resolve) => {
    releaseR2Credentials = resolve;
  });

  await page.addInitScript(() => {
    window.__appTest = { downloads: 0, objectUrls: { created: 0, revoked: 0 }, clipboardText: "" };
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { window.__appTest.clipboardText = value; } },
    });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    URL.createObjectURL = () => {
      window.__appTest.objectUrls.created += 1;
      return `blob:test-${window.__appTest.objectUrls.created}`;
    };
    URL.revokeObjectURL = () => {
      window.__appTest.objectUrls.revoked += 1;
    };
    HTMLAnchorElement.prototype.click = function click() {
      window.__appTest.downloads += 1;
    };
  });
  await page.addInitScript((disableRealtime) => {
    if (!disableRealtime) return;
    class UnavailablePeerConnection extends EventTarget {
      connectionState = "new";
      iceConnectionState = "new";
      iceGatheringState = "new";
      localDescription = null;
      remoteDescription = null;
      createDataChannel() {
        return {
          binaryType: "arraybuffer",
          readyState: "closed",
          close() {},
          addEventListener() {},
          removeEventListener() {},
        };
      }
      async createOffer() { throw new Error("E2E realtime unavailable"); }
      close() { this.connectionState = "closed"; }
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: UnavailablePeerConnection });
  }, options.disableRealtime ?? true);

  await page.route(`${apiBaseUrl}/api/auth/get-session`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(options.signedIn === false ? null : testAuthSession()),
    }),
  );
  await page.route(`${apiBaseUrl}/api/auth/sign-out`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) }),
  );
  await page.route(`${apiBaseUrl}/v1/usage`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        period: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z", timezone: "UTC" },
        summary: [
          { service: "direct", unit: "bytes", usage: 1_048_576, quota: 10_485_760 },
          { service: "stun", unit: "bytes", usage: 5_242_880, quota: 10_485_760 },
          { service: "turn", unit: "bytes", usage: 2_097_152, quota: 10_485_760 },
          { service: "sfu", unit: "bytes", usage: 4_194_304, quota: 10_485_760 },
          { service: "r2", unit: "bytes", usage: 3_145_728, quota: 10_485_760 },
          { service: "durable", unit: "requests", usage: 7, quota: 100 },
        ],
        totals: { bytes: 15_728_640, requests: 7 },
        quotas: { bytes: 52_428_800, requests: 100 },
        totalBytes: 15_728_640,
        totalQuotaBytes: 52_428_800,
      }),
    }),
  );
  await page.route(`${apiBaseUrl}/v1/turn/credentials`, (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        iceServers: [{
          urls: "turn:example.test:3478?transport=udp",
          username: "temporary-turn-user",
          credential: "temporary-turn-password",
        }],
      }),
    }),
  );
  await page.route(`${apiBaseUrl}/v1/sfu/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/sessions/new")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessionId: "e2e-sfu-session" }) });
    }
    if (pathname.endsWith("/datachannels/establish")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessionDescription: { type: "answer", sdp: "e2e-sfu-answer" },
          requiresImmediateRenegotiation: false,
        }),
      });
    }
    if (pathname.endsWith("/datachannels/new")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ dataChannels: [{ id: 7 }] }) });
    }
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.route(`${apiBaseUrl}/v1/r2/credentials`, async (route) => {
    if (options.holdR2Credentials) await r2CredentialGate;
    if (options.r2CredentialDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.r2CredentialDelayMs));
    }
    if (options.r2FailureStatus) {
      await route.fulfill({ status: options.r2FailureStatus, contentType: "application/json", body: JSON.stringify({ error: "R2 denied" }) }).catch(() => undefined);
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: "example-account",
        bucket: "demo-bucket",
        endpoint: r2Origin,
        objectKey: "users/server/demo.txt",
        accessKeyId: "temporary-access-key",
        secretAccessKey: "temporary-secret",
        sessionToken: "temporary-session-token/+==",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    }).catch(() => undefined);
  });
  await page.route(`${apiBaseUrl}/v1/diagnostics/transfers`, (route) =>
    route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) }),
  );
  await page.route(`${apiBaseUrl}/v1/pickups`, async (route) => {
    const body = await route.request().postDataJSON() as { offer?: string; variant: string };
    postedOffer = body.offer ?? "";
    postedVariant = body.variant;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ code: "12345678", expiresAt: Date.now() + 3_600_000 }),
    });
  });
  await page.route(`${apiBaseUrl}/v1/pickups/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/guest")) {
      const offer = options.pickupOffer ?? postedOffer;
      const pickup = offer
        ? {
            status: "found",
            variant: options.pickupVariant ?? (postedVariant || "multipath"),
            offer,
            expiresAt: Date.now() + 3_600_000,
            answered: false,
          }
        : {
            status: "pending",
            variant: options.pickupVariant ?? (postedVariant || "multipath"),
            expiresAt: Date.now() + 3_600_000,
          };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ token: "e2e-guest-token", expiresAt: Date.now() + 3_600_000, pickup }),
      });
      return;
    }
    if (pathname.endsWith("/offer")) {
      const body = await route.request().postDataJSON() as { offer: string };
      postedOffer = body.offer;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accepted: true }) });
      return;
    }
    if (pathname.endsWith("/status")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ cancelled: false, expiresAt: Date.now() + 3_600_000 }),
      });
      return;
    }
    if (pathname.endsWith("/cancel")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ cancelled: true }) });
      return;
    }
    if (/\/(answer|selection|winner)$/.test(pathname)) {
      if (route.request().method() === "GET") {
        if (pathname.endsWith("/answer")) {
          await route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer: null }) });
          return;
        }
        if (pathname.endsWith("/selection") && options.pickupSelection) {
          await route.fulfill({ contentType: "application/json", body: JSON.stringify({ route: options.pickupSelection }) });
          return;
        }
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "pending" }) });
      } else {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accepted: true }) });
      }
      return;
    }
    const offer = options.pickupOffer ?? postedOffer;
    if (!offer) {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          status: "pending",
          variant: options.pickupVariant ?? (postedVariant || "multipath"),
          expiresAt: Date.now() + 3_600_000,
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "found",
        variant: options.pickupVariant ?? "r2",
        offer,
        expiresAt: Date.now() + 3_600_000,
        answered: false,
      }),
    });
  });
  await page.route(`${r2Origin}/**`, async (route) => {
    if (route.request().method() === "PUT") {
      uploadedBody = route.request().postDataBuffer();
      uploadHeaders = route.request().headers();
      await route.fulfill({ status: 200, body: "" });
      return;
    }
    const body = options.downloadBody ?? "hello";
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: typeof body === "string" ? body : Buffer.from(body),
    });
  });

  return {
    getPostedOffer: () => postedOffer,
    getUploadedBody: () => uploadedBody,
    getUploadHeaders: () => uploadHeaders,
    getPostedVariant: () => postedVariant,
    releaseR2Credentials,
  };
}

export async function installRealRtcTransferMocks(context: BrowserContext) {
  let offer = "";
  let answer = "";
  let selection: "direct" | "stun" | null = null;
  let winner: { route: "direct" | "stun"; bytes: number; sha256: string } | null = null;
  let cancelled = false;
  const expiresAt = Date.now() + 3_600_000;
  const answerReady = deferredSignal();
  const selectionReady = deferredSignal();
  const winnerReady = deferredSignal();

  await context.addInitScript(() => {
    window.__appTest = { downloads: 0, objectUrls: { created: 0, revoked: 0 }, clipboardText: "" };
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { window.__appTest.clipboardText = value; } },
    });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    URL.createObjectURL = () => {
      window.__appTest.objectUrls.created += 1;
      return `blob:real-rtc-${window.__appTest.objectUrls.created}`;
    };
    URL.revokeObjectURL = () => { window.__appTest.objectUrls.revoked += 1; };
    HTMLAnchorElement.prototype.click = function click() { window.__appTest.downloads += 1; };
  });

  await context.route(`${apiBaseUrl}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (path === "/api/auth/get-session") return json(testAuthSession());
    if (path === "/v1/usage") {
      return json({
        period: { start: new Date().toISOString(), end: new Date(expiresAt).toISOString(), timezone: "UTC" },
        summary: [],
        totals: { bytes: 0, requests: 0 },
        quotas: { bytes: 0, requests: 0 },
        totalBytes: 0,
        totalQuotaBytes: 0,
      });
    }
    if (path === "/v1/diagnostics/transfers") return json({ accepted: true }, 202);
    if (path === "/v1/usage/transfers") return json({ recorded: true }, 201);
    if (path === "/v1/turn/credentials" || path === "/v1/r2/credentials" || path.startsWith("/v1/sfu/")) {
      // Return an application-level invalid payload so optional route setup
      // still falls back without Chromium reporting an expected HTTP error.
      return json({ error: "optional route disabled in native RTC test" });
    }
    if (path === "/v1/pickups" && method === "POST") {
      return json({ code: "12345678", expiresAt }, 201);
    }
    if (path === "/v1/pickups/12345678/offer" && method === "PUT") {
      offer = (await request.postDataJSON() as { offer: string }).offer;
      return json({ accepted: true });
    }
    if (path === "/v1/pickups/12345678/answer") {
      if (method === "PUT") {
        answer = (await request.postDataJSON() as { answer: string }).answer;
        answerReady.resolve();
        return json({ accepted: true });
      }
      if (!answer) await answerReady.promise;
      return json({ answer });
    }
    if (path === "/v1/pickups/12345678/selection") {
      if (method === "PUT") {
        selection = (await request.postDataJSON() as { route: "direct" | "stun" }).route;
        selectionReady.resolve();
        return json({ accepted: true });
      }
      if (!selection) await selectionReady.promise;
      return json({ route: selection });
    }
    if (path === "/v1/pickups/12345678/winner") {
      if (method === "PUT") {
        winner = await request.postDataJSON() as typeof winner;
        winnerReady.resolve();
        return json({ accepted: true });
      }
      if (!winner) await winnerReady.promise;
      return json(winner);
    }
    if (path === "/v1/pickups/12345678/status") return json({ cancelled, expiresAt });
    if (path === "/v1/pickups/12345678/cancel" && method === "PUT") {
      cancelled = true;
      return json({ cancelled: true });
    }
    if (path === "/v1/pickups/12345678") {
      return offer
        ? json({ status: "found", variant: "multipath", offer, expiresAt, answered: Boolean(answer) })
        : json({ status: "pending", variant: "multipath", expiresAt }, 202);
    }
    return json({ error: "not mocked" }, 404);
  });

  return {
    getOffer: () => offer,
    getSelection: () => selection,
    getWinner: () => winner,
  };
}

function deferredSignal() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

export function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

export async function expectNoConsoleErrors(errors: string[]) {
  expect(errors).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.body.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
}

export async function selectFile(page: Page, name = "hello.txt", content = "hello") {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(content),
  });
}

export async function decodeConnectionCodePayload(page: Page, code: string) {
  return page.evaluate(async (value) => {
    const base64UrlToBytes = (input: string) => {
      const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
      return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    };
    let json: string;
    if (value.startsWith("D1.")) {
      const stream = new Blob([base64UrlToBytes(value.slice(3))]).stream().pipeThrough(new DecompressionStream("gzip"));
      json = await new Response(stream).text();
    } else if (value.startsWith("J1.")) {
      json = new TextDecoder().decode(base64UrlToBytes(value.slice(3)));
    } else {
      json = value;
    }
    return JSON.parse(json) as Record<string, unknown>;
  }, code);
}

declare global {
  interface Window {
    __appTest: {
      downloads: number;
      objectUrls: { created: number; revoked: number };
      clipboardText: string;
    };
  }
}

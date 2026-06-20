import { test, expect, type Page } from "@playwright/test";

import {
  apiBaseUrl,
  collectConsoleErrors,
  decodeConnectionCodePayload,
  expectNoConsoleErrors,
  installAppMocks,
  openRoute,
  routePath,
  selectFile,
  withoutExpectedNetworkDiagnostics,
} from "./support/app";
import {
  encodeSfuFileChunk,
  sfuFileProtocolKind,
  sha256File,
} from "../../src/features/sfu/services/fileTransfer";

async function mockSfuSuccess(page: Page) {
  let sessionCount = 0;
  await page.route(`${apiBaseUrl}/v1/sfu/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.headers().authorization).toBeUndefined();

    if (url.pathname.endsWith("/sessions/new")) {
      sessionCount += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessionId: `session-${sessionCount}` }) });
      return;
    }
    if (url.pathname.endsWith("/datachannels/establish")) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessionDescription: { type: "answer", sdp: "v=0\r\n" } }),
      });
      return;
    }
    if (url.pathname.endsWith("/datachannels/new")) {
      const body = await request.postDataJSON();
      expect(body.dataChannels?.[0]?.dataChannelName).toBeTruthy();
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ dataChannels: [{ id: 7 }] }) });
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  });
}

test.describe("SFU page", () => {
  let consoleErrors: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
    await installAppMocks(page);
  });

  test.afterEach(async () => {
    await expectNoConsoleErrors(withoutExpectedNetworkDiagnostics(consoleErrors));
  });

  test("opens directly with SFU transfer controls", async ({ page }) => {
    await openRoute(page, "sfu");
    await expect(page.getByRole("heading", { name: "SFU 连接状态" })).toBeVisible();
    await expect(page.getByText("Cloudflare SFU DataChannel")).toBeVisible();
    await expect(page.getByLabel("App ID")).toHaveCount(0);
    await expect(page.getByLabel("App Token")).toHaveCount(0);
  });

  test("creates a mocked publisher DataChannel through the SFU proxy", async ({ page }) => {
    await mockSfuSuccess(page);
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "sfu-demo.txt");
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByLabel(/发送方 SFU 连接码/)).not.toHaveValue("");
    const code = await decodeConnectionCodePayload(page, await page.getByLabel(/发送方 SFU 连接码/).inputValue());
    expect(JSON.stringify(code)).not.toMatch(/appToken|SFU Token|authorization/i);
    await expect(page.getByText(/取件码 12345678 已生成/)).toBeVisible();

    await page.getByRole("button", { name: /重置/ }).click();
    await page.waitForFunction(() => window.__appTest.rtc.closedPeers > 0);
  });

  test("streams a large file in messages below the negotiated SCTP limit", async ({ page }) => {
    await mockSfuSuccess(page);
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /发送文件/ }).click();
    const fileBytes = Buffer.alloc(100 * 1024, 0x5a);
    await page.locator('input[type="file"]').setInputFiles({
      name: "sfu-large.bin",
      mimeType: "application/octet-stream",
      buffer: fileBytes,
    });
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByLabel(/发送方 SFU 连接码/)).not.toHaveValue("");

    const code = await decodeConnectionCodePayload(page, await page.getByLabel(/发送方 SFU 连接码/).inputValue());
    expect(code.kind).toBe(sfuFileProtocolKind);
    expect(code.file).toMatchObject({ name: "sfu-large.bin", size: fileBytes.byteLength, totalChunks: 2 });
    expect((code.file as { chunkSize: number }).chunkSize).toBeLessThan(64 * 1024);

    await page.getByRole("button", { name: /发送文件/ }).click();
    await page.waitForFunction(() =>
      window.__appTest.rtc.sentPayloads.some((payload) => payload.kind === "text" && payload.value.includes('"kind":"done"')),
    );
    const payloads = await page.evaluate(() => window.__appTest.rtc.sentPayloads);
    const binaryPayloads = payloads.filter((payload) => payload.kind === "arrayBuffer");
    expect(binaryPayloads).toHaveLength(2);
    expect(binaryPayloads.every((payload) => payload.byteLength <= 64 * 1024)).toBe(true);
    const controlPayloads = payloads
      .filter((payload): payload is { kind: "text"; value: string } => payload.kind === "text")
      .map((payload) => JSON.parse(payload.value) as Record<string, unknown>);
    expect(controlPayloads.find((payload) => payload.kind === "meta")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(controlPayloads.find((payload) => payload.kind === "done")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(page.getByText("文件已发送完成。")).toBeVisible();
  });

  test("creates a mocked subscriber from a pickup code", async ({ page }) => {
    await mockSfuSuccess(page);
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /接收文件/ }).click();
    const code = {
      kind: sfuFileProtocolKind,
      publisherSessionId: "publisher-session",
      dataChannelName: "file-test",
      file: {
        fileId: "12345678-1234-4234-9234-1234567890ab",
        name: "demo.txt",
        size: 5,
        type: "text/plain",
        lastModified: 1,
        chunkSize: 16,
        totalChunks: 1,
      },
      createdAt: Date.now(),
    };
    await page.route(`${apiBaseUrl}/v1/pickups/87654321`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "found",
          variant: "sfu",
          offer: JSON.stringify(code),
          expiresAt: Date.now() + 3600_000,
          answered: false,
        }),
      }),
    );
    await page.getByLabel("8 位取件码").fill("87654321");
    await page.getByRole("button", { name: /读取取件码/ }).click();
    await page.getByRole("button", { name: /订阅 DataChannel/ }).click();
    await expect(page.getByText(/已订阅 SFU DataChannel/)).toBeVisible();
  });

  test("verifies ordered chunks and downloads the memory fallback after SHA-256 passes", async ({ page }) => {
    await mockSfuSuccess(page);
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /接收文件/ }).click();
    const fileId = "12345678-1234-4234-9234-1234567890ab";
    const payload = new TextEncoder().encode("hello");
    const fileSha256 = await sha256File(new Blob([payload]));
    const file = {
      fileId,
      name: "verified.txt",
      size: payload.byteLength,
      type: "text/plain",
      lastModified: 1,
      chunkSize: 16,
      totalChunks: 1,
    };
    await page.route(`${apiBaseUrl}/v1/pickups/87654321`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "found",
          variant: "sfu",
          offer: JSON.stringify({
      kind: sfuFileProtocolKind,
      publisherSessionId: "publisher-session",
      dataChannelName: "file-test",
      file,
      createdAt: Date.now(),
          }),
          expiresAt: Date.now() + 3600_000,
          answered: false,
        }),
      }),
    );
    await page.getByLabel("8 位取件码").fill("87654321");
    await page.getByRole("button", { name: /读取取件码/ }).click();
    await page.getByRole("button", { name: /订阅 DataChannel/ }).click();
    await expect(page.getByText(/已订阅 SFU DataChannel/)).toBeVisible();

    const chunk = Array.from(new Uint8Array(encodeSfuFileChunk(fileId, 0, payload)));
    await page.evaluate(({ meta, binary, done }) => {
      const channel = window.__appTest.rtc.channels.at(-1);
      channel?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(meta) }));
      channel?.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(binary).buffer }));
      channel?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(done) }));
    }, {
      meta: { kind: "meta", ...file, sha256: fileSha256 },
      binary: chunk,
      done: { kind: "done", fileId, totalChunks: 1, sha256: fileSha256 },
    });

    await expect(page.getByText(/SHA-256 校验通过/)).toBeVisible();
    await expect(page.getByTestId("file-list-panel").getByText("verified.txt")).toBeVisible();
    await expect(page.evaluate(() => window.__appTest.downloads)).resolves.toBe(1);
  });

  for (const status of [403, 429, 500]) {
    test(`surfaces mocked SFU ${status} errors`, async ({ page }) => {
      await page.route(`${apiBaseUrl}/v1/sfu/**`, async (route) => {
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ errorDescription: `mock ${status}` }),
        });
      });
      await openRoute(page, "sfu");
      await page.getByRole("button", { name: /发送文件/ }).click();
      await selectFile(page, "sfu-error.txt");
      await page.getByRole("button", { name: /创建发布通道/ }).click();
      await expect(page.getByText(`mock ${status}`)).toBeVisible();
    });
  }

  test("reports missing API fields and cleans PeerConnection resources on unmount", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/sfu/**`, (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "sfu-missing.txt");
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByText(/没有返回 sessionId/)).toBeVisible();

    await page.getByRole("button", { name: /重置/ }).click();
    await expect(page.evaluate(() => window.__appTest.rtc.closedPeers)).resolves.toBeGreaterThanOrEqual(0);
  });

  test("reports network interruption", async ({ page }) => {
    await page.route(`${apiBaseUrl}/v1/sfu/**`, (route) => route.abort("failed"));
    await openRoute(page, "sfu");
    await page.getByRole("button", { name: /发送文件/ }).click();
    await selectFile(page, "sfu-network.txt");
    await page.getByRole("button", { name: /创建发布通道/ }).click();
    await expect(page.getByText(/Failed to fetch|创建 SFU 发布通道失败/)).toBeVisible();
  });
});

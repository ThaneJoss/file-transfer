import { expect, test } from "@playwright/test";

import {
  collectConsoleErrors,
  decodeConnectionCodePayload,
  expectNoConsoleErrors,
  installRealRtcTransferMocks,
  selectFile,
} from "./support/app";

test("transfers an encrypted file through native browser WebRTC", async ({ page }) => {
  test.setTimeout(60_000);
  const senderErrors = collectConsoleErrors(page);
  const mocks = await installRealRtcTransferMocks(page.context());
  await page.goto("/");

  await selectFile(page, "native-rtc.txt", "hello over native rtc");
  await page.getByRole("button", { name: "生成取件码" }).click();
  await expect(page.getByTestId("pickup-code")).toHaveText("12345678");
  await page.getByRole("button", { name: "复制分享链接" }).click();
  const shareUrl = await page.evaluate(() => window.__appTest.clipboardText);
  expect(shareUrl).toContain("?code=12345678#key=");

  const receiver = await page.context().newPage();
  const receiverErrors = collectConsoleErrors(receiver);
  await receiver.goto(shareUrl);
  await expect(receiver.getByTestId("receiver-file")).toContainText("native-rtc.txt", { timeout: 15_000 });
  await receiver.getByRole("button", { name: "开始接收" }).click();

  await expect(receiver.getByTestId("download-complete")).toContainText("文件已安全保存", { timeout: 30_000 });
  await expect(page.getByTestId("upload-complete")).toContainText("已完成校验", { timeout: 30_000 });
  await expect(receiver.evaluate(() => window.__appTest.downloads)).resolves.toBe(1);
  expect(mocks.getSelection()).toMatch(/^(direct|stun)$/);
  expect(mocks.getWinner()).toMatchObject({ bytes: 21 });

  const payload = await decodeConnectionCodePayload(page, mocks.getOffer());
  expect(payload.kind).toBe("file-transfer-v4");
  expect(payload.encryption).toMatchObject({ algorithm: "AES-GCM-256" });

  await receiver.close();
  await expectNoConsoleErrors(senderErrors);
  await expectNoConsoleErrors(receiverErrors);
});

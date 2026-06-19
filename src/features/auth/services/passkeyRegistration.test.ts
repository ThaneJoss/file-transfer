import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { createPasskeyRegistrationContext } from "./passkeyRegistration";

describe("Passkey registration context", () => {
  it("requests a signed registration context with session cookies", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/passkey/registration-context", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(await request.json()).toEqual({ name: "测试用户" });
        return HttpResponse.json({ context: "signed-context" }, { status: 201 });
      }),
    );

    await expect(createPasskeyRegistrationContext("测试用户")).resolves.toEqual({ context: "signed-context" });
  });

  it("rejects an empty registration context", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/passkey/registration-context", () =>
        HttpResponse.json({ context: " " }, { status: 201 }),
      ),
    );

    await expect(createPasskeyRegistrationContext("测试用户")).rejects.toThrow("Passkey 注册上下文为空。");
  });
});

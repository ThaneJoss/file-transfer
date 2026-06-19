import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { requestR2Credentials } from "./r2Credentials";

describe("R2 temporary credentials", () => {
  it("requests a server-generated object key with a 900 second TTL", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/r2/credentials", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(await request.json()).toEqual({ fileName: "测试.txt", ttlSeconds: 900 });
        return HttpResponse.json({
          accountId: "account",
          bucket: "bucket",
          endpoint: "https://account.r2.cloudflarestorage.com",
          objectKey: "users/server-generated-key.txt",
          accessKeyId: "temporary-id",
          secretAccessKey: "temporary-secret",
          sessionToken: "temporary-session",
          expiresAt: "2026-06-20T12:00:00.000Z",
        });
      }),
    );

    const result = await requestR2Credentials("测试.txt");
    expect(result.objectKey).toBe("users/server-generated-key.txt");
    expect(result.sessionToken).toBe("temporary-session");
  });
});

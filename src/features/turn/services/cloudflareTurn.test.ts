import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { generateCloudflareTurnIceServers, normalizeIceServers } from "./cloudflareTurn";

describe("Cloudflare TURN service", () => {
  it("generates temporary iceServers without placing the token in the URL", async () => {
    server.use(
      http.post("https://rtc.live.cloudflare.com/v1/turn/keys/:keyId/credentials/generate-ice-servers", async ({ params, request }) => {
        expect(params.keyId).toBe("test-key");
        expect(request.url).not.toContain("test-token");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(await request.json()).toEqual({ ttl: 3600 });
        return HttpResponse.json({
          iceServers: [
            {
              urls: ["turn:example.com:3478?transport=udp", "turn:example.com:3478?transport=tcp"],
              username: "user",
              credential: "temporary-password",
            },
          ],
        });
      }),
    );

    await expect(generateCloudflareTurnIceServers("test-key", "test-token", 3600)).resolves.toEqual([
      {
        urls: ["turn:example.com:3478?transport=udp", "turn:example.com:3478?transport=tcp"],
        username: "user",
        credential: "temporary-password",
      },
    ]);
  });

  it("maps API failures to status-specific messages", async () => {
    server.use(
      http.post("https://rtc.live.cloudflare.com/v1/turn/keys/:keyId/credentials/generate-ice-servers", () =>
        HttpResponse.json({ errors: [{ message: "invalid token" }] }, { status: 401 }),
      ),
    );

    await expect(generateCloudflareTurnIceServers("test-key", "test-token", 3600)).rejects.toThrow("invalid token");
  });

  it("normalizes only valid RTCIceServer objects", () => {
    expect(
      normalizeIceServers([
        null,
        { urls: 123 },
        { urls: "turn:example.com", username: "user", credential: "credential" },
      ]),
    ).toEqual([{ urls: "turn:example.com", username: "user", credential: "credential" }]);
  });
});

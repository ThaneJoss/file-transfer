import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { generateCloudflareTurnIceServers, normalizeIceServers } from "./cloudflareTurn";

describe("Cloudflare TURN service", () => {
  it("requests temporary TURN servers without exposing credentials in a URL", async () => {
    server.use(http.post("https://api.file.thanejoss.com/v1/turn/credentials", async ({ request }) => {
      expect(request.credentials).toBe("include");
      expect(await request.json()).toEqual({ ttlSeconds: 3600 });
      return HttpResponse.json({
        iceServers: [{
          urls: ["turn:example.com:3478?transport=udp", "turn:example.com:3478?transport=tcp"],
          username: "user",
          credential: "temporary-password",
        }],
      });
    }));

    await expect(generateCloudflareTurnIceServers(3600)).resolves.toEqual([{
      urls: ["turn:example.com:3478?transport=udp", "turn:example.com:3478?transport=tcp"],
      username: "user",
      credential: "temporary-password",
    }]);
  });

  it("forwards cancellation to the credentials request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateCloudflareTurnIceServers(3600, {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("normalizes only valid RTCIceServer objects", () => {
    expect(normalizeIceServers([
      null,
      { urls: 123 },
      { urls: "turn:example.com", username: "user", credential: "credential" },
    ])).toEqual([{ urls: "turn:example.com", username: "user", credential: "credential" }]);
  });
});

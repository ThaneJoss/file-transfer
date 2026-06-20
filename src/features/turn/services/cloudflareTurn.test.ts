import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { generateCloudflareTurnIceServers, normalizeIceServers } from "./cloudflareTurn";

describe("Cloudflare TURN service", () => {
  it("generates temporary iceServers without placing the token in the URL", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/turn/credentials", async ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(request.headers.get("authorization")).toBeNull();
        expect(await request.json()).toEqual({ ttlSeconds: 3600, fileSizeBytes: 1024 });
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

    await expect(generateCloudflareTurnIceServers(3600, 1024)).resolves.toEqual([
      {
        urls: ["turn:example.com:3478?transport=udp", "turn:example.com:3478?transport=tcp"],
        username: "user",
        credential: "temporary-password",
      },
    ]);
  });

  it("maps API failures to status-specific messages", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/turn/credentials", () =>
        HttpResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    );

    await expect(generateCloudflareTurnIceServers(3600, undefined)).rejects.toThrow("Unauthorized");
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

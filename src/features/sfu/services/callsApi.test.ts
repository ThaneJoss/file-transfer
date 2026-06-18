import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { callsFetch, createCallsSession, validateSfuCredentials } from "./callsApi";

describe("Cloudflare Realtime Calls API service", () => {
  it("creates a session with bearer auth and a trimmed app id", async () => {
    const peerConnection = {} as RTCPeerConnection;
    server.use(
      http.post("https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/new", ({ params, request }) => {
        expect(params.appId).toBe("fake-app-id");
        expect(request.url).not.toContain("test-token");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({ sessionId: "session-1" });
      }),
    );

    await expect(createCallsSession({ appId: " fake-app-id ", appToken: " test-token " }, peerConnection)).resolves.toEqual({
      id: "session-1",
      peerConnection,
    });
  });

  it("reports auth and server API failures", async () => {
    server.use(
      http.post("https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/new", () =>
        HttpResponse.json({ errorDescription: "forbidden" }, { status: 403 }),
      ),
    );

    await expect(callsFetch({ appId: "fake-app-id", appToken: "test-token" }, "/sessions/new", { method: "POST" })).rejects.toThrow(
      "forbidden",
    );
  });

  it("validates empty credentials before making a request", () => {
    expect(() => validateSfuCredentials({ appId: "", appToken: "" })).toThrow("App ID");
  });
});

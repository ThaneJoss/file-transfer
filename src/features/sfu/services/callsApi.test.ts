import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { callsFetch, createCallsSession } from "./callsApi";

describe("Cloudflare Realtime Calls API service", () => {
  it("creates a session through the authenticated backend proxy", async () => {
    const peerConnection = {} as RTCPeerConnection;
    server.use(
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/new", ({ request }) => {
        expect(request.credentials).toBe("include");
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("content-type")).toBe("application/json");
        return HttpResponse.json({ sessionId: "session-1" });
      }),
    );

    await expect(createCallsSession(peerConnection)).resolves.toEqual({
      id: "session-1",
      peerConnection,
    });
  });

  it("reports auth and server API failures", async () => {
    server.use(
      http.post("https://api.file.thanejoss.com/v1/sfu/sessions/new", () =>
        HttpResponse.json({ errorDescription: "forbidden" }, { status: 403 }),
      ),
    );

    await expect(callsFetch("/sessions/new", { method: "POST" })).rejects.toThrow(
      "forbidden",
    );
  });
});

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/mocks/server";
import { classifyTransferError, TransferDiagnosticSession } from "./transferDiagnostics";

describe("transfer diagnostics", () => {
  it("reports only bounded capability and route metadata", async () => {
    let payload: Record<string, unknown> | null = null;
    server.use(
      http.post("https://api.file.thanejoss.com/v1/diagnostics/transfers", async ({ request }) => {
        payload = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ accepted: true }, { status: 202 });
      }),
    );
    const diagnostic = new TransferDiagnosticSession();
    diagnostic.updateRoutes({ direct: "failed", r2: "complete" });

    await expect(diagnostic.flush({
      side: "receiver",
      outcome: "complete",
      mode: "auto",
      winner: "r2",
    })).resolves.toBe(true);

    expect(payload).toMatchObject({
      id: diagnostic.id,
      side: "receiver",
      outcome: "complete",
      mode: "auto",
      winner: "r2",
      routes: { direct: "failed", r2: "complete" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/fileName|pickupCode|secret|offer|answer/i);
    await expect(diagnostic.flush({ side: "receiver", outcome: "complete", mode: "auto" })).resolves.toBe(false);
  });

  it("maps raw errors to stable privacy-safe codes", () => {
    expect(classifyTransferError(new Error("文件完整性 SHA-256 不一致"))).toBe("INTEGRITY_MISMATCH");
    expect(classifyTransferError(new Error("TURN 凭据不可用"))).toBe("TURN_FAILURE");
    expect(classifyTransferError(new TypeError("fetch failed"))).toBe("NETWORK_FAILURE");
  });
});

import { test } from "@playwright/test";

test.describe("live integrations", () => {
  test.skip(!process.env.LIVE_E2E, "Live tests are disabled by default and require short-lived service credentials.");

  test("placeholder for protected live TURN/SFU/R2 checks", async () => {
    test.skip(true, "Add protected live checks only when all required credentials are present.");
  });
});

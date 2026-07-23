import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: workerRoot,
  resolve: {
    alias: [
      {
        find: /^@simplewebauthn\/server$/u,
        replacement: fileURLToPath(
          new URL("./test/simplewebauthn-server.ts", import.meta.url),
        ),
      },
    ],
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-06-19",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        durableObjects: {
          PICKUP_SESSIONS: { className: "PickupSession", useSQLite: true },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./migrations", import.meta.url)),
          ),
          BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
          BETTER_AUTH_URL: "https://api.file.thanejoss.com",
          APP_ORIGIN: "https://file.thanejoss.com",
          TURN_KEY_ID: "test",
          TURN_KEY_API_TOKEN: "test",
          R2_ACCOUNT_ID: "test",
          R2_BUCKET: "test",
          R2_PARENT_API_TOKEN: "test",
          R2_PARENT_ACCESS_KEY_ID: "test",
          SFU_APP_ID: "test",
          SFU_APP_TOKEN: "test",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});

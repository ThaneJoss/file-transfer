import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateRoot = join(root, ".wrangler", "passkey-browser");
mkdirSync(stateRoot, { recursive: true });
const directory = mkdtempSync(join(stateRoot, "run-"));
const configPath = join(directory, "wrangler.json");
const persistencePath = join(directory, "state");
const assetsPath = join(directory, "dist");
const origin = "http://localhost:8788";
const vite = fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json")));
const wrangler = fileURLToPath(new URL("./bin/wrangler.js", import.meta.resolve("wrangler/package.json")));
const childEnv = {
  ...process.env,
  CI: "true",
  NODE_ENV: "production",
  VITE_API_BASE_URL: origin,
  WRANGLER_SEND_METRICS: "false",
};

// This config is generated under .wrangler and contains no production resource
// IDs. Both migration and serving commands explicitly select local execution.
writeFileSync(configPath, JSON.stringify({
  name: "file-transfer-passkey-browser",
  main: join(root, "worker", "src", "index.ts"),
  compatibility_date: "2026-06-19",
  compatibility_flags: ["nodejs_compat"],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  vars: {
    BETTER_AUTH_URL: origin,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: "local-browser-test-secret-at-least-32-characters",
    TURN_KEY_ID: "local-test",
    TURN_KEY_API_TOKEN: "local-test",
    R2_ACCOUNT_ID: "local-test",
    R2_BUCKET: "local-test",
    R2_PARENT_API_TOKEN: "local-test",
    R2_PARENT_ACCESS_KEY_ID: "local-test",
    SFU_APP_ID: "local-test",
    SFU_APP_TOKEN: "local-test",
  },
  d1_databases: [{
    binding: "DB",
    database_name: "file-transfer-browser-test",
    database_id: "00000000-0000-0000-0000-000000000001",
    migrations_dir: join(root, "worker", "migrations"),
  }],
  durable_objects: {
    bindings: [{ name: "PICKUP_SESSIONS", class_name: "PickupSession" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["PickupSession"] }],
  assets: {
    directory: assetsPath,
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/v1/*", "/health"],
  },
}, null, 2));

function run(entrypoint, args) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`[passkey-browser] Isolated local state: ${directory}`);
run(vite, ["build", "--outDir", assetsPath]);
run(wrangler, [
  "d1", "migrations", "apply", "file-transfer-browser-test",
  "--local", "--config", configPath, "--persist-to", persistencePath,
]);

const server = spawn(process.execPath, [
  wrangler, "dev", "--local", "--config", configPath,
  "--ip", "127.0.0.1", "--port", "8788", "--persist-to", persistencePath,
], { cwd: root, env: childEnv, stdio: "inherit", windowsHide: true });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
server.on("error", (error) => { throw error; });
server.on("exit", (code) => process.exit(code ?? 1));

import { spawnSync } from "node:child_process";

const pnpmEntrypoint = process.env.npm_execpath;
const pnpmCommand = pnpmEntrypoint ? process.execPath : "pnpm";
const pnpmPrefix = pnpmEntrypoint ? [pnpmEntrypoint] : [];

function runPnpm(args) {
  const result = spawnSync(pnpmCommand, [...pnpmPrefix, ...args], {
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.WORKERS_CI === "1") {
  console.log("[build] Cloudflare Workers target");
  runPnpm(["exec", "tsc", "--noEmit", "-p", "worker/tsconfig.json"]);
} else {
  console.log("[build] Vercel/frontend target");
  runPnpm(["exec", "tsc", "-b"]);
  runPnpm(["exec", "vite", "build"]);
  runPnpm(["run", "check:bundle"]);
}

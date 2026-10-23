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

// Workers Builds sets WORKERS_CI for both projects. An explicit target lets the
// frontend build assets while preserving the existing API project's command.
const target = process.argv[2] ?? (process.env.WORKERS_CI === "1" ? "worker" : "frontend");

if (target === "worker") {
  console.log("[build] Cloudflare Workers target");
  runPnpm(["exec", "tsc", "--noEmit", "-p", "worker/tsconfig.json"]);
} else if (target === "frontend") {
  console.log("[build] Frontend static assets target");
  runPnpm(["exec", "tsc", "-b"]);
  runPnpm(["exec", "vite", "build"]);
  runPnpm(["run", "check:bundle"]);
} else {
  throw new Error(`Unknown build target: ${target}`);
}

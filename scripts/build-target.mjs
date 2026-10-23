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

// One release contains the API and frontend assets, in local and CI builds.
// The frontend-only target is useful for starting the local API dev server.
const target = process.argv[2] ?? "all";
if (!["all", "frontend", "worker"].includes(target)) {
  throw new Error(`Unknown build target: ${target}`);
}
if (target === "all" || target === "worker") {
  console.log("[build] Worker API typecheck");
  runPnpm(["exec", "tsc", "--noEmit", "-p", "worker/tsconfig.json"]);
}
if (target === "all" || target === "frontend") {
  console.log("[build] Frontend static assets");
  runPnpm(["exec", "tsc", "-b"]);
  runPnpm(["exec", "vite", "build"]);
  runPnpm(["run", "check:bundle"]);
}

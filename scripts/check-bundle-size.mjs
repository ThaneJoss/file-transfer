import { readFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const distDirectory = path.resolve("dist");
const manifestPath = path.join(distDirectory, ".vite", "manifest.json");
const kibibyte = 1024;
const limits = {
  initialGzip: numberFromEnvironment("BUNDLE_MAX_INITIAL_GZIP_KIB", 115) * kibibyte,
  largestGzip: numberFromEnvironment("BUNDLE_MAX_CHUNK_GZIP_KIB", 95) * kibibyte,
  totalGzip: numberFromEnvironment("BUNDLE_MAX_TOTAL_GZIP_KIB", 175) * kibibyte,
};

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const assetNames = (await readdir(path.join(distDirectory, "assets")))
  .filter((name) => name.endsWith(".js"));
const gzipSizes = new Map();
for (const name of assetNames) {
  const bytes = await readFile(path.join(distDirectory, "assets", name));
  gzipSizes.set(`assets/${name}`, gzipSync(bytes).byteLength);
}

const entry = Object.values(manifest).find((item) => item && item.isEntry);
if (!entry) throw new Error("Bundle budget: Vite manifest has no entry chunk.");
const initialFiles = collectStaticImports(entry, manifest);
const initialGzip = sum(initialFiles.map((file) => gzipSizes.get(file) ?? 0));
const totalGzip = sum([...gzipSizes.values()]);
const [largestFile, largestGzip] = [...gzipSizes.entries()].sort((left, right) => right[1] - left[1])[0] ?? ["none", 0];

console.log(
  `Bundle budget: initial ${format(initialGzip)}, largest ${format(largestGzip)} (${largestFile}), total ${format(totalGzip)}.`,
);

const failures = [];
if (initialGzip > limits.initialGzip) failures.push(`initial ${format(initialGzip)} > ${format(limits.initialGzip)}`);
if (largestGzip > limits.largestGzip) failures.push(`largest ${format(largestGzip)} > ${format(limits.largestGzip)}`);
if (totalGzip > limits.totalGzip) failures.push(`total ${format(totalGzip)} > ${format(limits.totalGzip)}`);
if (failures.length) throw new Error(`Bundle budget exceeded: ${failures.join(", ")}`);

function collectStaticImports(entryItem, records, files = new Set()) {
  if (entryItem.file?.endsWith(".js")) files.add(entryItem.file);
  for (const key of entryItem.imports ?? []) {
    const imported = records[key];
    if (imported && !files.has(imported.file)) collectStaticImports(imported, records, files);
  }
  return [...files];
}

function numberFromEnvironment(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function format(bytes) {
  return `${(bytes / kibibyte).toFixed(1)} KiB gzip`;
}

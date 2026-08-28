import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const artifactDirectory = process.argv[2] ?? "core/node-native/artifacts";
const expected = new Set([
  "atalk-core-native.darwin-arm64.node",
  "atalk-core-native.darwin-x64.node",
  "atalk-core-native.linux-arm64-gnu.node",
  "atalk-core-native.linux-arm64-musl.node",
  "atalk-core-native.linux-x64-gnu.node",
  "atalk-core-native.linux-x64-musl.node",
  "atalk-core-native.win32-arm64-msvc.node",
  "atalk-core-native.win32-x64-msvc.node",
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

const actual = new Set((await listFiles(artifactDirectory)).filter((file) => file.endsWith(".node")).map(basename));
const missing = [...expected].filter((file) => !actual.has(file));
const unexpected = [...actual].filter((file) => !expected.has(file));

if (missing.length || unexpected.length) {
  throw new Error(`Invalid native artifact set. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`);
}

console.log(`Verified ${actual.size} native artifacts`);

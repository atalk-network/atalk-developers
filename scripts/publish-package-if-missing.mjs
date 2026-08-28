import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [packageDirectory, packageManager, tag] = process.argv.slice(2);

if (!packageDirectory || !["npm", "pnpm"].includes(packageManager) || !tag) {
  throw new Error(
    "Usage: node scripts/publish-package-if-missing.mjs <package-directory> <npm|pnpm> <dist-tag>",
  );
}

const manifestPath = resolve(packageDirectory, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
  throw new Error(`${manifestPath} must define string name and version fields`);
}

const versionUrl = new URL(
  `${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`,
  "https://registry.npmjs.org/",
);
const response = await fetch(versionUrl, {
  headers: { accept: "application/json" },
});

if (response.ok) {
  console.log(`${manifest.name}@${manifest.version} already exists; skipping publish`);
  process.exit(0);
}

if (response.status !== 404) {
  throw new Error(
    `Unable to check ${manifest.name}@${manifest.version}: npm registry returned ${response.status}`,
  );
}

const args = packageManager === "npm"
  ? ["publish", resolve(packageDirectory), "--access", "public", "--tag", tag]
  : ["--dir", packageDirectory, "publish", "--access", "public", "--tag", tag, "--no-git-checks"];

console.log(`Publishing ${manifest.name}@${manifest.version} with ${packageManager}`);

const child = spawn(packageManager, args, {
  env: process.env,
  stdio: "inherit",
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`${packageManager} publish terminated by ${signal}`));
    else resolveExit(code ?? 1);
  });
});

if (exitCode !== 0) process.exit(exitCode);

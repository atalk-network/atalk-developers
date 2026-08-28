import { copyFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const action = process.argv[2];
const repositoryLicense = resolve("LICENSE");
const nativeDirectory = resolve("core/node-native");
const nativeLicense = resolve(nativeDirectory, "LICENSE");
const platformDirectory = resolve(nativeDirectory, "npm");

async function platformLicensePaths() {
  try {
    const entries = await readdir(platformDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(platformDirectory, entry.name, "LICENSE"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const targets = [nativeLicense, ...await platformLicensePaths()];

if (action === "stage") {
  await Promise.all(targets.map((target) => copyFile(repositoryLicense, target)));
  console.log(`Staged licenses for ${targets.length} native packages`);
} else if (action === "clean") {
  await Promise.all(targets.map((target) => rm(target, { force: true })));
} else {
  throw new Error("Usage: node scripts/native-package-licenses.mjs <stage|clean>");
}

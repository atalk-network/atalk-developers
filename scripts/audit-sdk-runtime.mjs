import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const protocol = JSON.parse(await readFile("core/protocol/package.json", "utf8"));
const sdk = JSON.parse(await readFile("sdk/node/package.json", "utf8"));
const dependencies = { ...protocol.dependencies };

for (const [name, version] of Object.entries(sdk.dependencies)) {
  if (!name.startsWith("@atalk/")) dependencies[name] = version;
}

const directory = await mkdtemp(join(tmpdir(), "atalk-sdk-audit-"));
try {
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`);
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-fund", "--no-audit"], {
    cwd: directory,
    stdio: "inherit",
  });
  execFileSync("npm", ["audit", "--omit=dev", "--audit-level=high"], {
    cwd: directory,
    stdio: "inherit",
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

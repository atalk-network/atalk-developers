import { readFile } from "node:fs/promises";

const release = process.argv[2];
const tag = process.argv[3];

if (!release || !tag) {
  throw new Error("Usage: node scripts/verify-release-versions.mjs <node|python> <tag>");
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

if (release === "node") {
  const expected = tag.replace(/^node-v/u, "");
  if (expected === tag) throw new Error(`Node release tag must start with node-v: ${tag}`);

  const manifests = await Promise.all([
    readJson("core/protocol/package.json"),
    readJson("core/node-native/package.json"),
    readJson("sdk/node/package.json"),
  ]);
  for (const manifest of manifests) {
    if (manifest.version !== expected) {
      throw new Error(`${manifest.name} is ${manifest.version}, expected ${expected} from ${tag}`);
    }
  }
  console.log(`Verified coordinated Node release ${expected}`);
} else if (release === "python") {
  const expected = tag.replace(/^python-v/u, "");
  if (expected === tag) throw new Error(`Python release tag must start with python-v: ${tag}`);
  const pyproject = await readFile("sdk/python/pyproject.toml", "utf8");
  const actual = /^version = "([^"]+)"$/mu.exec(pyproject)?.[1];
  if (actual !== expected) throw new Error(`atalk-sdk is ${actual ?? "missing"}, expected ${expected} from ${tag}`);
  console.log(`Verified Python release ${expected}`);
} else {
  throw new Error(`Unknown release family: ${release}`);
}

if (process.env.GITHUB_REPOSITORY) {
  const expectedRepository = `github.com/${process.env.GITHUB_REPOSITORY}`;
  const files = ["core/protocol/package.json", "core/node-native/package.json", "sdk/node/package.json", "sdk/python/pyproject.toml"];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    if (!contents.includes(expectedRepository)) {
      throw new Error(`${file} does not point to the publishing repository ${expectedRepository}`);
    }
  }
}

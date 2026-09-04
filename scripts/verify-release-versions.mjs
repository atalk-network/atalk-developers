import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
    readJson("integrations/gateway/package.json"),
    readJson("integrations/mcp/package.json"),
    readJson("integrations/openclaw/package.json"),
    readJson("integrations/agent-plugin/package.json"),
  ]);
  for (const manifest of manifests) {
    if (manifest.version !== expected) {
      throw new Error(`${manifest.name} is ${manifest.version}, expected ${expected} from ${tag}`);
    }
  }

  const sdkRuntime = await readFile("sdk/node/src/runtime-update.ts", "utf8");
  const exportedSdkVersion = /export const ATALK_SDK_VERSION = "([^"]+)"/u.exec(sdkRuntime)?.[1];
  if (exportedSdkVersion !== expected) {
    throw new Error(`ATALK_SDK_VERSION is ${exportedSdkVersion ?? "missing"}, expected ${expected} from ${tag}`);
  }

  const plugin = await readJson("integrations/agent-plugin/plugin.json");
  if (plugin.version !== expected) {
    throw new Error(`agent plugin is ${plugin.version ?? "missing"}, expected ${expected} from ${tag}`);
  }
  const runtimeLock = await readJson("integrations/gateway/runtime-dependency-lock.json");
  if (runtimeLock?.version !== 1 || runtimeLock?.root?.name !== "@atalk/gateway"
    || runtimeLock.root.version !== expected || !runtimeLock.packages || !Array.isArray(runtimeLock.required)) {
    throw new Error(`Gateway runtime dependency lock does not describe @atalk/gateway@${expected}`);
  }
  for (const [name, version] of Object.entries(runtimeLock.packages)) {
    if (name.startsWith("@atalk/") && version !== expected) {
      throw new Error(`Gateway runtime dependency lock pins ${name}@${version}, expected ${expected}`);
    }
  }
  if (!runtimeLock.required.includes("@atalk/gateway")) {
    throw new Error("Gateway runtime dependency lock must require the root Gateway package");
  }
  const listed = JSON.parse(execFileSync("pnpm", [
    "--filter", "@atalk/gateway", "list", "--prod", "--depth", "Infinity", "--json",
  ], { encoding: "utf8" }));
  const root = listed[0];
  if (!root || root.name !== "@atalk/gateway" || root.version !== expected) {
    throw new Error("Could not resolve the Gateway production dependency graph");
  }
  const observed = new Map([[root.name, root.version]]);
  const visit = async (name, dependency) => {
    const version = String(dependency.version).startsWith("link:")
      ? (await readJson(join(dependency.path, "package.json"))).version
      : dependency.version;
    if (typeof version !== "string") throw new Error(`Could not resolve runtime dependency ${name}`);
    const previous = observed.get(name);
    if (previous && previous !== version) {
      throw new Error(`Runtime graph contains multiple versions of ${name}: ${previous}, ${version}`);
    }
    observed.set(name, version);
    for (const [childName, child] of Object.entries(dependency.dependencies ?? {})) {
      await visit(childName, child);
    }
  };
  for (const [name, dependency] of Object.entries(root.dependencies ?? {})) await visit(name, dependency);
  for (const [name, version] of observed) {
    if (runtimeLock.packages[name] !== version) {
      throw new Error(`Gateway runtime dependency lock pins ${name}@${runtimeLock.packages[name] ?? "missing"}, resolved ${version}`);
    }
  }
  const required = new Set(runtimeLock.required);
  if (required.size !== observed.size || [...observed.keys()].some((name) => !required.has(name))) {
    throw new Error("Gateway runtime dependency lock required set does not match the resolved production graph");
  }
  for (const name of Object.keys(runtimeLock.packages)) {
    if (!observed.has(name) && !name.startsWith("@atalk/core-native-")) {
      throw new Error(`Gateway runtime dependency lock contains unexpected optional package ${name}`);
    }
  }
  const pluginMcp = await readJson("integrations/agent-plugin/mcp.json");
  const mcpArguments = pluginMcp?.mcpServers?.atalk?.args;
  const pinnedMcp = Array.isArray(mcpArguments)
    ? mcpArguments.find((value) => String(value).startsWith("@atalk/mcp-server@"))
    : undefined;
  if (pinnedMcp !== `@atalk/mcp-server@${expected}`) {
    throw new Error(`agent plugin MCP pin is ${pinnedMcp ?? "missing"}, expected @atalk/mcp-server@${expected}`);
  }

  const nativeLoader = await readFile("core/node-native/index.js", "utf8");
  const nativeExpectedVersions = new Set(
    [...nativeLoader.matchAll(/binding package version mismatch, expected ([^ ]+) but got/gu)]
      .map((match) => match[1]),
  );
  if (nativeExpectedVersions.size !== 1 || !nativeExpectedVersions.has(expected)) {
    throw new Error(`native loader expects ${[...nativeExpectedVersions].join(", ") || "no version"}, expected ${expected}`);
  }
  console.log(`Verified coordinated Node release ${expected}`);
} else if (release === "python") {
  const expected = tag.replace(/^python-v/u, "");
  if (expected === tag) throw new Error(`Python release tag must start with python-v: ${tag}`);
  const pyproject = await readFile("sdk/python/pyproject.toml", "utf8");
  const actual = /^version = "([^"]+)"$/mu.exec(pyproject)?.[1];
  if (actual !== expected) throw new Error(`atalk-sdk is ${actual ?? "missing"}, expected ${expected} from ${tag}`);
  const hermesProject = await readFile("integrations/hermes/pyproject.toml", "utf8");
  const hermesVersion = /^version = "([^"]+)"$/mu.exec(hermesProject)?.[1];
  if (hermesVersion !== expected) throw new Error(`atalk-hermes is ${hermesVersion ?? "missing"}, expected ${expected} from ${tag}`);
  const hermesManifest = await readFile("integrations/hermes/plugin.yaml", "utf8");
  const manifestVersion = /^version: ([^\s]+)$/mu.exec(hermesManifest)?.[1];
  if (manifestVersion !== expected) {
    throw new Error(`Hermes plugin manifest is ${manifestVersion ?? "missing"}, expected ${expected} from ${tag}`);
  }
  if (!hermesManifest.includes(`atalk-sdk==${expected}`)) {
    throw new Error(`Hermes plugin manifest must pin atalk-sdk==${expected}`);
  }
  console.log(`Verified Python release ${expected}`);
} else {
  throw new Error(`Unknown release family: ${release}`);
}

if (process.env.GITHUB_REPOSITORY) {
  const expectedRepository = `github.com/${process.env.GITHUB_REPOSITORY}`;
  const files = [
    "core/protocol/package.json",
    "core/node-native/package.json",
    "sdk/node/package.json",
    "sdk/python/pyproject.toml",
    "integrations/gateway/package.json",
    "integrations/mcp/package.json",
    "integrations/openclaw/package.json",
    "integrations/agent-plugin/package.json",
    "integrations/hermes/pyproject.toml",
  ];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    if (!contents.includes(expectedRepository)) {
      throw new Error(`${file} does not point to the publishing repository ${expectedRepository}`);
    }
  }
}

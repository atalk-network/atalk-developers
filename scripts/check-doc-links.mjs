import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const markdownRoots = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "docs", "core", "sdk", "integrations"];
const requiredReleaseFiles = [
  "docs/architecture.md",
  "docs/security.md",
  "docs/protocol.md",
  "docs/integrations.md",
  "docs/agent-multimedia.md",
  "docs/supervision-and-temporary-authorizations.md",
  "docs/workrooms-and-mandates.md",
  "docs/workrooms-ui-contract.md",
  "docs/adr/0005-encrypted-workrooms-and-signed-mandates.md",
  "sdk/node/src/workrooms.ts",
  "sdk/python/src/atalk/workrooms.py",
];

const markdownFiles = [];
for (const entry of markdownRoots) await collectMarkdown(resolve(root, entry), markdownFiles);

for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    const rawTarget = match[1];
    if (/^(?:https?:|mailto:)/u.test(rawTarget) || rawTarget.startsWith("#")) continue;
    const pathname = decodeURIComponent(rawTarget.split("#", 1)[0]);
    if (!pathname) continue;
    const target = resolve(dirname(file), pathname);
    if (!target.startsWith(`${root}/`) && target !== root) {
      throw new Error(`${relative(file)}: link escapes the public repository: ${rawTarget}`);
    }
    await access(target).catch(() => {
      throw new Error(`${relative(file)}: missing local link target: ${rawTarget}`);
    });
  }
}

for (const file of requiredReleaseFiles) {
  await access(resolve(root, file)).catch(() => {
    throw new Error(`Required public release file is missing: ${file}`);
  });
}

const packageFiles = [
  "core/protocol/package.json",
  "core/node-native/package.json",
  "sdk/node/package.json",
  "integrations/gateway/package.json",
  "integrations/openclaw/package.json",
  "integrations/mcp/package.json",
  "integrations/agent-plugin/package.json",
];
const manifests = await Promise.all(packageFiles.map(async (file) => JSON.parse(await readFile(resolve(root, file), "utf8"))));
const nodeVersion = manifests[0].version;
for (const manifest of manifests) {
  if (manifest.version !== nodeVersion) throw new Error(`${manifest.name} is not on coordinated Node version ${nodeVersion}`);
  if (!JSON.stringify(manifest.repository).includes("github.com/atalk-network/atalk-developers")) {
    throw new Error(`${manifest.name} does not point to the public repository`);
  }
}

if (process.argv.includes("--remote")) {
  const urls = [
    "https://github.com/atalk-network/atalk-developers",
    "https://registry.npmjs.org/@atalk%2fprotocol",
    "https://registry.npmjs.org/@atalk%2fsdk",
    "https://registry.npmjs.org/@atalk%2fgateway",
    "https://registry.npmjs.org/@atalk%2fmcp-server",
    "https://registry.npmjs.org/@atalk%2fopenclaw",
    "https://registry.npmjs.org/@atalk%2fagent-plugin",
    "https://pypi.org/pypi/atalk-sdk/json",
    "https://pypi.org/pypi/atalk-hermes/json",
  ];
  for (const url of urls) {
    const response = await fetch(url, {
      headers: { "user-agent": "atalk-public-release-link-check/1" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Remote release link returned ${response.status}: ${url}`);
  }
}

console.log(`Verified ${markdownFiles.length} Markdown files, ${requiredReleaseFiles.length} release files and coordinated Node ${nodeVersion}${process.argv.includes("--remote") ? " with registry links" : ""}`);

async function collectMarkdown(target, result) {
  const metadata = await stat(target);
  if (metadata.isFile()) {
    if (extname(target) === ".md") result.push(target);
    return;
  }
  for (const name of await readdir(target)) {
    if (["dist", "node_modules", "target", ".venv"].includes(name)) continue;
    await collectMarkdown(resolve(target, name), result);
  }
}

function relative(file) {
  return file.slice(root.length + 1);
}

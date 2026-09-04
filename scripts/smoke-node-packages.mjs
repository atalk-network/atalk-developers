import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = process.cwd();
const nativeDirectory = resolve("core/node-native");
const nativeManifestPath = join(nativeDirectory, "package.json");
const originalNativeManifest = await readFile(nativeManifestPath, "utf8");
const scratch = await mkdtemp(join(tmpdir(), "atalk-node-packages-"));
const packageDirectory = join(scratch, "packages");
const consumerDirectory = join(scratch, "consumer");

const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: repository,
  stdio: "inherit",
  ...options,
});

function platformPackageDirectory() {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "win32") return `win32-${process.arch}-msvc`;
  if (process.platform === "linux") {
    const glibc = process.report?.getReport().header?.glibcVersionRuntime;
    return `linux-${process.arch}-${glibc ? "gnu" : "musl"}`;
  }
  throw new Error(`Unsupported smoke-test platform: ${process.platform}-${process.arch}`);
}

try {
  await rm(join(nativeDirectory, "npm"), { recursive: true, force: true });
  run("pnpm", ["--dir", "core/protocol", "build"]);
  run("pnpm", ["--dir", "core/node-native", "build"]);
  run("pnpm", ["--dir", "sdk/node", "build"]);
  run("pnpm", ["--dir", "integrations/gateway", "build"]);
  run("pnpm", ["--dir", "integrations/mcp", "build"]);
  run("pnpm", ["--dir", "integrations/openclaw", "build"]);
  run("pnpm", ["--dir", "integrations/agent-plugin", "test"]);
  run("pnpm", ["--dir", "core/node-native", "exec", "napi", "create-npm-dirs"]);
  const platformDirectory = platformPackageDirectory();
  const platformManifest = JSON.parse(await readFile(join(nativeDirectory, "npm", platformDirectory, "package.json"), "utf8"));
  const nativeFile = platformManifest.main;
  await copyFile(join(nativeDirectory, nativeFile), join(nativeDirectory, "npm", platformDirectory, nativeFile));

  const nativeManifest = JSON.parse(originalNativeManifest);
  nativeManifest.optionalDependencies = {};
  for (const directory of await readdir(join(nativeDirectory, "npm"))) {
    const manifest = JSON.parse(await readFile(join(nativeDirectory, "npm", directory, "package.json"), "utf8"));
    nativeManifest.optionalDependencies[manifest.name] = manifest.version;
  }
  await writeFile(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`);
  run("node", ["scripts/native-package-licenses.mjs", "stage"]);

  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
  ]);

  run("pnpm", ["--dir", "core/protocol", "pack", "--pack-destination", packageDirectory]);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", packageDirectory], { cwd: nativeDirectory });
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", packageDirectory], {
    cwd: join(nativeDirectory, "npm", platformDirectory),
  });
  run("pnpm", ["--dir", "sdk/node", "pack", "--pack-destination", packageDirectory]);
  run("pnpm", ["--dir", "integrations/gateway", "pack", "--pack-destination", packageDirectory]);
  run("pnpm", ["--dir", "integrations/mcp", "pack", "--pack-destination", packageDirectory]);
  run("pnpm", ["--dir", "integrations/openclaw", "pack", "--pack-destination", packageDirectory]);
  run("pnpm", ["--dir", "integrations/agent-plugin", "pack", "--pack-destination", packageDirectory]);

  const tarballs = (await readdir(packageDirectory)).filter((file) => file.endsWith(".tgz")).map((file) => join(packageDirectory, file));
  if (tarballs.length !== 8) throw new Error(`Expected eight tarballs, found ${tarballs.length}`);

  await writeFile(join(consumerDirectory, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: consumerDirectory });
  const installedSdkDirectory = join(consumerDirectory, "node_modules", "@atalk", "sdk", "dist");
  const installedAgentTypes = await readFile(join(installedSdkDirectory, "agent.d.ts"), "utf8");
  const installedAgentRuntime = await readFile(join(installedSdkDirectory, "agent.js"), "utf8");
  const installedIndexTypes = await readFile(join(installedSdkDirectory, "index.d.ts"), "utf8");
  const installedWorkroomTypes = await readFile(join(installedSdkDirectory, "workrooms.d.ts"), "utf8");
  const installedWorkroomRuntime = await readFile(join(installedSdkDirectory, "workrooms.js"), "utf8");
  for (const expected of [
    "token?: string",
    "isSupervisor: boolean",
    "routing:",
    'mode: "REPLY" | "RELAY"',
    "relay(text: string): Promise<string>",
    "markRead(): Promise<void>",
    "sendWithDetails(recipientHandle: string, text: string): Promise<SentMessage>",
  ]) {
    if (!installedAgentTypes.includes(expected)) throw new Error(`Packed Node SDK is missing public API: ${expected}`);
  }
  for (const expected of ["/v1/agent-runtime/supervisors", "encodeAgentActivity", "Only supervisor messages can be relayed"]) {
    if (!installedAgentRuntime.includes(expected)) throw new Error(`Packed Node SDK is missing runtime behavior: ${expected}`);
  }
  for (const expected of ["WorkroomClient", "MandatedExecutionResult", "DecryptedWorkroomEvent"]) {
    if (!installedIndexTypes.includes(expected)) throw new Error(`Packed Node SDK is missing Task export: ${expected}`);
  }
  for (const expected of ["directedToMe: boolean", "readAuditEvents(", "publishMandated(", "submitFileMandated("]) {
    if (!installedWorkroomTypes.includes(expected)) throw new Error(`Packed Node SDK is missing Task API: ${expected}`);
  }
  for (const expected of ["decrypted.directedToMe", "evaluateMandateUse", "signWorkroomReceipt"]) {
    if (!installedWorkroomRuntime.includes(expected)) throw new Error(`Packed Node SDK is missing Task runtime boundary: ${expected}`);
  }
  run("node", ["--input-type=module", "--eval", "import { RUST_CORE_VERSION } from '@atalk/sdk'; if (!RUST_CORE_VERSION) process.exit(1); console.log(`Installed aTalk Rust core ${RUST_CORE_VERSION}`);"], { cwd: consumerDirectory });
  run("node", ["--input-type=module", "--eval", "import { GATEWAY_SPEC } from '@atalk/gateway'; if (GATEWAY_SPEC !== 'atalk.gateway/v1') process.exit(1); console.log(`Installed ${GATEWAY_SPEC}`);"], { cwd: consumerDirectory });
  for (const file of [
    "node_modules/@atalk/mcp-server/dist/server.js",
    "node_modules/@atalk/openclaw/openclaw.plugin.json",
    "node_modules/@atalk/agent-plugin/plugin.json",
    "node_modules/@atalk/agent-plugin/skills/atalk/SKILL.md",
  ]) {
    await access(join(consumerDirectory, file));
  }
} finally {
  await writeFile(nativeManifestPath, originalNativeManifest);
  run("node", ["scripts/native-package-licenses.mjs", "clean"]);
  await rm(join(nativeDirectory, "npm"), { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}

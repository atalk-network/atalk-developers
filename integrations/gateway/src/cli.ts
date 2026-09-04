#!/usr/bin/env node
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
  ATALK_SDK_VERSION,
  isManagedRuntimeProcess,
  type AgentRuntimeOptions,
  type RuntimeUpdatePolicy,
} from "@atalk/sdk";
import { createAtalkGateway } from "./gateway.js";
import { gatewayOpenApiDocument } from "./openapi.js";
import { NodeRuntimeManager } from "./runtime-manager.js";

const MANAGED_CHILD_SHUTDOWN_DEADLINE_MS = 5_000;

export interface CliOptions {
  command: "start" | "pair" | "doctor" | "self-test" | "manager-start" | "manager-status" | "manager-update" | "help";
  host: string;
  port: number;
  baseUrl: string;
  credentialPath: string;
  inboxPath?: string;
  webhookUrl?: string;
  managerPolicy: RuntimeUpdatePolicy;
  managerStateDirectory?: string;
  managerPollIntervalMs: number;
  dryRun: boolean;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseOptions(args: string[]): CliOptions {
  const rawCommand = args[0] ?? "start";
  const explicitManagerAction = rawCommand === "manager" && args[1] && !args[1].startsWith("--")
    ? args[1]
    : undefined;
  const managerAction = rawCommand === "manager" ? explicitManagerAction ?? "start" : undefined;
  const command = rawCommand === "--help" || rawCommand === "-h"
    ? "help"
    : managerAction
      ? `manager-${managerAction}`
      : rawCommand;
  if (command !== "start" && command !== "pair" && command !== "doctor" && command !== "self-test" && command !== "help"
    && command !== "manager-start" && command !== "manager-status" && command !== "manager-update") {
    throw new Error(`Unknown command: ${rawCommand}`);
  }
  const optionStart = rawCommand === "manager" && explicitManagerAction ? 2 : 1;
  validateOptions(args.slice(optionStart), command as CliOptions["command"]);
  const listenerCommand = command === "start" || command.startsWith("manager-");
  const rawPort = valueAfter(args, "--port")
    ?? (listenerCommand ? process.env.ATALK_GATEWAY_PORT : undefined)
    ?? "8788";
  const port = /^\d+$/u.test(rawPort) ? Number.parseInt(rawPort, 10) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Gateway port must be between 1 and 65535");
  const webhookUrl = valueAfter(args, "--webhook-url") ?? process.env.ATALK_WEBHOOK_URL;
  const inboxPath = valueAfter(args, "--inbox-path") ?? process.env.ATALK_GATEWAY_INBOX_PATH;
  const managerCommand = command.startsWith("manager-");
  const managerPolicy = valueAfter(args, "--policy")
    ?? (managerCommand ? process.env.ATALK_UPDATE_POLICY : undefined)
    ?? "COMPATIBLE";
  if (managerPolicy !== "NOTIFY" && managerPolicy !== "SECURITY" && managerPolicy !== "COMPATIBLE") {
    throw new Error("Runtime Manager policy must be NOTIFY, SECURITY, or COMPATIBLE");
  }
  const rawPollSeconds = valueAfter(args, "--poll-seconds")
    ?? (managerCommand ? process.env.ATALK_UPDATE_POLL_SECONDS : undefined)
    ?? "60";
  const pollSeconds = /^\d+$/u.test(rawPollSeconds) ? Number.parseInt(rawPollSeconds, 10) : Number.NaN;
  if (!Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 86_400) {
    throw new Error("Runtime Manager poll interval must be between 1 and 86400 seconds");
  }
  const managerStateDirectory = valueAfter(args, "--state-dir")
    ?? (managerCommand ? process.env.ATALK_RUNTIME_MANAGER_STATE : undefined);
  return {
    command: command as CliOptions["command"],
    host: valueAfter(args, "--host") ?? process.env.ATALK_GATEWAY_HOST ?? "127.0.0.1",
    port,
    baseUrl: valueAfter(args, "--base-url") ?? process.env.ATALK_BASE_URL ?? "https://api.atalk.ar",
    credentialPath: resolve(valueAfter(args, "--credential-path") ?? process.env.ATALK_CREDENTIAL_PATH ?? join(homedir(), ".atalk", "gateway-agent.json")),
    ...(inboxPath ? { inboxPath: resolve(inboxPath) } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
    managerPolicy,
    ...(managerStateDirectory ? { managerStateDirectory: resolve(managerStateDirectory) } : {}),
    managerPollIntervalMs: pollSeconds * 1_000,
    dryRun: args.includes("--dry-run"),
  };
}

function validateOptions(args: string[], command: CliOptions["command"]): void {
  const commonValueOptions = new Set([
    "--base-url", "--credential-path", "--inbox-path", "--host", "--port", "--webhook-url",
  ]);
  const managerValueOptions = new Set(["--policy", "--state-dir", "--poll-seconds"]);
  const allowedValues = command.startsWith("manager-")
    ? new Set([...commonValueOptions, ...managerValueOptions])
    : command === "self-test" || command === "help"
      ? new Set<string>()
      : commonValueOptions;
  const seen = new Set<string>();
  for (let index = 0; index < args.length;) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      if (command !== "manager-update") throw new Error("--dry-run is only valid for manager update");
      if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
      seen.add(argument);
      index += 1;
      continue;
    }
    if (!argument.startsWith("--") || !allowedValues.has(argument)) {
      throw new Error(`Unknown option or argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    seen.add(argument);
    index += 2;
  }
}

function help(): void {
  process.stdout.write(`aTalk Agent Gateway\n\nUsage:\n  atalk-gateway pair             Pair an aTalk agent once\n  atalk-gateway start            Start the local HTTP/webhook gateway\n  atalk-gateway doctor           Verify credentials, connectivity and version status\n  atalk-gateway self-test        Offline package/import validation (no credentials or aTalk network)\n  atalk-gateway manager start    Supervise the gateway and apply permitted updates safely\n  atalk-gateway manager status   Show active version, advisory and policy decision\n  atalk-gateway manager update   Restage an eligible exact version (--dry-run to inspect only)\n\nOptions:\n  --base-url URL           aTalk API (default: https://api.atalk.ar)\n  --credential-path PATH   Private agent credential file location\n  --inbox-path PATH        Durable inbox file (defaults next to credentials)\n  --host HOST              Listen host (default: 127.0.0.1)\n  --port PORT              Listen port (default: 8788)\n  --webhook-url URL        Deliver incoming events to a webhook\n  --policy POLICY          COMPATIBLE (default), SECURITY, or NOTIFY\n  --state-dir PATH         Isolated Runtime Manager versions and active marker\n  --poll-seconds N         Advisory watch interval (default: 60)\n  --dry-run                Do not stage or activate an update\n\nEnvironment:\n  ATALK_AGENT_TOKEN        One-time activation token (pairing only)\n  ATALK_GATEWAY_API_KEY    Required when listening outside localhost\n  ATALK_GATEWAY_INBOX_PATH Optional durable inbox file location\n  ATALK_ENABLE_WORKROOM_AUDIT  Set to true only for an operator-facing gateway\n  ATALK_ENABLE_UNSAFE_WORKROOM_IO  Set to true only for a trusted manual client\n  ATALK_WEBHOOK_SECRET     HMAC-SHA256 webhook signing secret\n  ATALK_GATEWAY_ALLOW_ORIGIN  Optional browser CORS origin\n  ATALK_UPDATE_POLICY      Local maximum update policy (default: COMPATIBLE)\n`);
}

function environmentFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolveSecret, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      resolveSecret(value.trim());
    };
    const onData = (chunk: Buffer) => {
      const input = chunk.toString("utf8");
      if (input === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        reject(new Error("Pairing cancelled"));
        return;
      }
      if (input === "\r" || input === "\n") {
        finish();
        return;
      }
      if (input === "\u007f" || input === "\b") {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (/^[\x20-\x7E]+$/u.test(input)) {
        value += input;
        process.stdout.write("•".repeat(input.length));
      }
    };
    process.stdin.on("data", onData);
  });
}

async function pair(options: CliOptions): Promise<void> {
  const hasCredentials = await access(options.credentialPath).then(() => true).catch(() => false);
  const token = process.env.ATALK_AGENT_TOKEN ?? (hasCredentials ? undefined : await readSecret("Paste the one-time aTalk connection code: "));
  if (!token && !hasCredentials) throw new Error("An activation token is required for first-time pairing");
  const agent = new Agent({
    ...(token ? { token } : {}),
    baseUrl: options.baseUrl,
    credentialPath: options.credentialPath,
    runtime: gatewayRuntimeOptions(),
  });
  await agent.start();
  process.stdout.write(`${hasCredentials ? "Verified" : "Paired"} ${agent.peer?.handle ?? "aTalk agent"}. Credentials: ${options.credentialPath}\n`);
  await agent.stop();
}

async function doctor(options: CliOptions): Promise<void> {
  const agent = new Agent({
    baseUrl: options.baseUrl,
    credentialPath: options.credentialPath,
    runtime: gatewayRuntimeOptions(),
  });
  await agent.start();
  await agent.checkForRuntimeUpdate();
  const advisory = agent.runtimeUpdate;
  process.stdout.write(`OK: ${agent.peer?.handle ?? "agent"} can connect to ${options.baseUrl}; gateway ${ATALK_SDK_VERSION}; update ${advisory?.status ?? "UNKNOWN"}${advisory?.recommendedVersion ? ` (${advisory.recommendedVersion} recommended)` : ""}\n`);
  await agent.stop();
}

function selfTest(): void {
  // Reaching this branch proves that the CLI, SDK, native core and Gateway
  // modules all loaded. Exercise a pure API surface without credentials,
  // filesystem state, child processes or aTalk/network I/O.
  const document = gatewayOpenApiDocument();
  if (document.openapi !== "3.1.0" || !document.paths["/health"]) {
    throw new Error("Gateway offline self-test failed");
  }
  process.stdout.write(`OK: aTalk Gateway ${ATALK_SDK_VERSION} offline self-test passed\n`);
}

async function start(options: CliOptions): Promise<void> {
  const managed = managedRuntimeEnvironment();
  const gateway = createAtalkGateway({
    baseUrl: options.baseUrl,
    credentialPath: options.credentialPath,
    ...(options.inboxPath ? { inboxPath: options.inboxPath } : {}),
    host: options.host,
    port: options.port,
    ...(process.env.ATALK_AGENT_TOKEN ? { token: process.env.ATALK_AGENT_TOKEN } : {}),
    ...(process.env.ATALK_GATEWAY_API_KEY ? { apiKey: process.env.ATALK_GATEWAY_API_KEY } : {}),
    ...(environmentFlag(process.env.ATALK_ENABLE_WORKROOM_AUDIT) ? { allowWorkroomAudit: true } : {}),
    ...(environmentFlag(process.env.ATALK_ENABLE_UNSAFE_WORKROOM_IO) ? { allowUnsafeWorkroomIo: true } : {}),
    ...(process.env.ATALK_GATEWAY_ALLOW_ORIGIN ? { allowOrigin: process.env.ATALK_GATEWAY_ALLOW_ORIGIN } : {}),
    ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
    ...(process.env.ATALK_WEBHOOK_SECRET ? { webhookSecret: process.env.ATALK_WEBHOOK_SECRET } : {}),
    ...(process.env.ATALK_UPDATE_STATUS_PATH ? { runtimeUpdateStatusPath: process.env.ATALK_UPDATE_STATUS_PATH } : {}),
    ...(managed ? { managedRuntime: true } : {}),
  });
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownGatewayWithDeadline(
      () => gateway.stop(),
      exitCode,
      (code) => { process.exit(code); },
    );
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  if (managed) {
    // The Runtime Manager launches this process with an IPC channel. Its
    // closure is cross-platform parent-death detection, including SIGKILL/OOM.
    process.once("disconnect", () => void shutdown(1));
  }
  await gateway.start();
  if (managed && process.connected !== true) {
    await shutdown(1);
    return;
  }
  process.stdout.write(`aTalk Gateway connected as ${gateway.agent.peer?.handle ?? "unknown"} at ${gateway.url}\n`);
}

export async function shutdownGatewayWithDeadline(
  stop: () => Promise<void>,
  requestedExitCode: number,
  exit: (code: number) => void,
  deadlineMs = MANAGED_CHILD_SHUTDOWN_DEADLINE_MS,
): Promise<void> {
  let forced = false;
  const failureExitCode = requestedExitCode === 0 ? 1 : requestedExitCode;
  const deadline = setTimeout(() => {
    forced = true;
    exit(failureExitCode);
  }, deadlineMs);
  try {
    await stop();
    if (!forced) exit(requestedExitCode);
  } catch {
    if (!forced) exit(failureExitCode);
  } finally {
    clearTimeout(deadline);
  }
}

function gatewayRuntimeOptions(): AgentRuntimeOptions {
  return {
    integration: { name: "@atalk/gateway", version: ATALK_SDK_VERSION },
    capabilities: [
      "e2ee", "text", "attachments", "directed-mentions", "supervision", "workrooms", "gateway.http",
      ...(managedRuntimeEnvironment() ? ["runtime.auto-update"] : []),
    ],
    ...(process.env.ATALK_UPDATE_STATUS_PATH ? { updateStatusPath: process.env.ATALK_UPDATE_STATUS_PATH } : {}),
  };
}

function managedRuntimeEnvironment(): boolean {
  return isManagedRuntimeProcess();
}

function runtimeManager(options: CliOptions): NodeRuntimeManager {
  return new NodeRuntimeManager({
    bootstrapEntrypoint: fileURLToPath(import.meta.url),
    bootstrapVersion: ATALK_SDK_VERSION,
    credentialPath: options.credentialPath,
    ...(options.managerStateDirectory ? { stateDirectory: options.managerStateDirectory } : {}),
    localPolicy: options.managerPolicy,
    pollIntervalMs: options.managerPollIntervalMs,
    gatewayHost: options.host,
    gatewayPort: options.port,
    ...(process.env.ATALK_GATEWAY_API_KEY ? { gatewayApiKey: process.env.ATALK_GATEWAY_API_KEY } : {}),
    childEnvironment: {
      ATALK_BASE_URL: options.baseUrl,
      ...(options.inboxPath ? { ATALK_GATEWAY_INBOX_PATH: options.inboxPath } : {}),
      ...(options.webhookUrl ? { ATALK_WEBHOOK_URL: options.webhookUrl } : {}),
      ...(process.env.ATALK_WEBHOOK_SECRET ? { ATALK_WEBHOOK_SECRET: process.env.ATALK_WEBHOOK_SECRET } : {}),
      ...(process.env.ATALK_GATEWAY_ALLOW_ORIGIN ? { ATALK_GATEWAY_ALLOW_ORIGIN: process.env.ATALK_GATEWAY_ALLOW_ORIGIN } : {}),
      ...(environmentFlag(process.env.ATALK_ENABLE_WORKROOM_AUDIT) ? { ATALK_ENABLE_WORKROOM_AUDIT: "true" } : {}),
      ...(environmentFlag(process.env.ATALK_ENABLE_UNSAFE_WORKROOM_IO) ? { ATALK_ENABLE_UNSAFE_WORKROOM_IO: "true" } : {}),
    },
  });
}

async function managerStart(options: CliOptions): Promise<void> {
  const manager = runtimeManager(options);
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  process.stdout.write(`aTalk Runtime Manager ${ATALK_SDK_VERSION} supervising with ${options.managerPolicy} policy\n`);
  await manager.run(abort.signal);
}

async function managerStatus(options: CliOptions): Promise<void> {
  process.stdout.write(`${JSON.stringify(await runtimeManager(options).status(), null, 2)}\n`);
}

async function managerUpdate(options: CliOptions): Promise<void> {
  const result = await runtimeManager(options).update({ dryRun: options.dryRun });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.changed) {
    process.stdout.write("Staged the verified runtime; no activation occurred. `manager start` owns atomic activation, restart and rollback health checks.\n");
    if (result.approvedVersion) {
      process.stdout.write(`Approved ${result.approvedVersion} for one supervised attempt. --dry-run never creates approval.\n`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help") help();
  else if (options.command === "pair") await pair(options);
  else if (options.command === "doctor") await doctor(options);
  else if (options.command === "self-test") selfTest();
  else if (options.command === "manager-start") await managerStart(options);
  else if (options.command === "manager-status") await managerStatus(options);
  else if (options.command === "manager-update") await managerUpdate(options);
  else await start(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`[aTalk Gateway] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

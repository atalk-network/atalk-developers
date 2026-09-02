#!/usr/bin/env node
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Agent } from "@atalk/sdk";
import { createAtalkGateway } from "./gateway.js";

interface CliOptions {
  command: "start" | "pair" | "doctor" | "help";
  host: string;
  port: number;
  baseUrl: string;
  credentialPath: string;
  webhookUrl?: string;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseOptions(args: string[]): CliOptions {
  const rawCommand = args[0] ?? "start";
  const command = rawCommand === "--help" || rawCommand === "-h" ? "help" : rawCommand;
  if (command !== "start" && command !== "pair" && command !== "doctor" && command !== "help") {
    throw new Error(`Unknown command: ${rawCommand}`);
  }
  const rawPort = valueAfter(args, "--port") ?? process.env.ATALK_GATEWAY_PORT ?? "8788";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Gateway port must be between 1 and 65535");
  const webhookUrl = valueAfter(args, "--webhook-url") ?? process.env.ATALK_WEBHOOK_URL;
  return {
    command,
    host: valueAfter(args, "--host") ?? process.env.ATALK_GATEWAY_HOST ?? "127.0.0.1",
    port,
    baseUrl: valueAfter(args, "--base-url") ?? process.env.ATALK_BASE_URL ?? "https://api.atalk.ar",
    credentialPath: resolve(valueAfter(args, "--credential-path") ?? process.env.ATALK_CREDENTIAL_PATH ?? join(homedir(), ".atalk", "gateway-agent.json")),
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

function help(): void {
  process.stdout.write(`aTalk Agent Gateway\n\nUsage:\n  atalk-gateway pair       Pair an aTalk agent once\n  atalk-gateway start      Start the local HTTP/webhook gateway\n  atalk-gateway doctor     Verify credentials and connectivity\n\nOptions:\n  --base-url URL           aTalk API (default: https://api.atalk.ar)\n  --credential-path PATH   Private agent credential file location\n  --host HOST              Listen host (default: 127.0.0.1)\n  --port PORT              Listen port (default: 8788)\n  --webhook-url URL        Deliver incoming events to a webhook\n\nEnvironment:\n  ATALK_AGENT_TOKEN        One-time activation token (pairing only)\n  ATALK_GATEWAY_API_KEY    Required when listening outside localhost\n  ATALK_WEBHOOK_SECRET     HMAC-SHA256 webhook signing secret\n  ATALK_GATEWAY_ALLOW_ORIGIN  Optional browser CORS origin\n`);
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
  const agent = new Agent({ ...(token ? { token } : {}), baseUrl: options.baseUrl, credentialPath: options.credentialPath });
  await agent.start();
  process.stdout.write(`${hasCredentials ? "Verified" : "Paired"} ${agent.peer?.handle ?? "aTalk agent"}. Credentials: ${options.credentialPath}\n`);
  await agent.stop();
}

async function doctor(options: CliOptions): Promise<void> {
  const agent = new Agent({ baseUrl: options.baseUrl, credentialPath: options.credentialPath });
  await agent.start();
  process.stdout.write(`OK: ${agent.peer?.handle ?? "agent"} can connect to ${options.baseUrl}\n`);
  await agent.stop();
}

async function start(options: CliOptions): Promise<void> {
  const gateway = createAtalkGateway({
    baseUrl: options.baseUrl,
    credentialPath: options.credentialPath,
    host: options.host,
    port: options.port,
    ...(process.env.ATALK_AGENT_TOKEN ? { token: process.env.ATALK_AGENT_TOKEN } : {}),
    ...(process.env.ATALK_GATEWAY_API_KEY ? { apiKey: process.env.ATALK_GATEWAY_API_KEY } : {}),
    ...(process.env.ATALK_GATEWAY_ALLOW_ORIGIN ? { allowOrigin: process.env.ATALK_GATEWAY_ALLOW_ORIGIN } : {}),
    ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
    ...(process.env.ATALK_WEBHOOK_SECRET ? { webhookSecret: process.env.ATALK_WEBHOOK_SECRET } : {}),
  });
  await gateway.start();
  process.stdout.write(`aTalk Gateway connected as ${gateway.agent.peer?.handle ?? "unknown"} at ${gateway.url}\n`);
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help") help();
  else if (options.command === "pair") await pair(options);
  else if (options.command === "doctor") await doctor(options);
  else await start(options);
}

main().catch((error: unknown) => {
  process.stderr.write(`[aTalk Gateway] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

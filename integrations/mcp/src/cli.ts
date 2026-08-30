#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAtalkMcpServer } from "./server.js";

const runtime = createAtalkMcpServer();

async function main(): Promise<void> {
  await runtime.start();
  await runtime.server.connect(new StdioServerTransport());
  console.error(`[aTalk] MCP connected as ${runtime.agent.peer?.handle ?? "unknown"}`);
}

async function shutdown(): Promise<void> {
  await runtime.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

main().catch((error: unknown) => {
  console.error(`[aTalk] MCP startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

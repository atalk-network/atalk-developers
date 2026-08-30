import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distributionDirectory = resolve(process.argv[2] ?? "sdk/node/dist");
const types = await readFile(resolve(distributionDirectory, "agent.d.ts"), "utf8");
const runtime = await readFile(resolve(distributionDirectory, "agent.js"), "utf8");

for (const expected of [
  "token?: string",
  "isSupervisor: boolean",
  "relay(text: string): Promise<string>",
  "markRead(): Promise<void>",
  "sendWithDetails(recipientHandle: string, text: string): Promise<SentMessage>",
  "sendInConversation(recipientHandle: string, text: string, conversationId: string): Promise<string>",
]) {
  if (!types.includes(expected)) throw new Error(`Node SDK package is missing public API: ${expected}`);
}

for (const expected of ["/v1/agent-runtime/supervisors", "encodeAgentActivity", "Only supervisor messages can be relayed"]) {
  if (!runtime.includes(expected)) throw new Error(`Node SDK package is missing runtime behavior: ${expected}`);
}

console.log("Verified packaged Node integration API and runtime behavior");

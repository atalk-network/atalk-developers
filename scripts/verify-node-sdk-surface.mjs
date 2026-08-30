import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distributionDirectory = resolve(process.argv[2] ?? "sdk/node/dist");
const types = await readFile(resolve(distributionDirectory, "agent.d.ts"), "utf8");
const runtime = await readFile(resolve(distributionDirectory, "agent.js"), "utf8");

for (const expected of ["supervision?: boolean", "isSupervisor: boolean", "relay(text: string): Promise<void>"]) {
  if (!types.includes(expected)) throw new Error(`Node SDK package is missing public API: ${expected}`);
}

for (const expected of ["/v1/agent-runtime/supervisors", "encodeAgentActivity", "Only supervisor messages can be relayed"]) {
  if (!runtime.includes(expected)) throw new Error(`Node SDK package is missing runtime behavior: ${expected}`);
}

console.log("Verified packaged Node supervision API and runtime behavior");

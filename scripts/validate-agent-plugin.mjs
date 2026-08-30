import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "integrations/agent-plugin");
const plugin = JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8"));
const mcp = JSON.parse(await readFile(resolve(directory, "mcp.json"), "utf8"));

if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
  throw new Error("plugin.json must target Agent Plugins 1.0.0");
}
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(plugin.name) || plugin.name.includes("--") || plugin.name.includes("..")) {
  throw new Error("plugin.json has an invalid name");
}
if (mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") {
  throw new Error("mcp.json must target Agent Plugins 1.0.0");
}
const server = mcp.mcpServers?.atalk;
if (server?.type !== "stdio" || server.command !== "npx" || !Array.isArray(server.args)) {
  throw new Error("mcp.json does not declare the expected aTalk stdio server");
}
if (Object.hasOwn(server.env ?? {}, "PLUGIN_ROOT") || Object.hasOwn(server.env ?? {}, "PLUGIN_DATA")) {
  throw new Error("PLUGIN_ROOT and PLUGIN_DATA are controlled by the host");
}
if (!String(server.env?.ATALK_CREDENTIAL_PATH).startsWith("${PLUGIN_DATA}/")) {
  throw new Error("aTalk credentials must live under PLUGIN_DATA");
}

console.log(`Validated Agent Plugin ${plugin.name} ${plugin.version}`);

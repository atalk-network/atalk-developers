import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distributionDirectory = resolve(process.argv[2] ?? "sdk/node/dist");
const types = await readFile(resolve(distributionDirectory, "agent.d.ts"), "utf8");
const runtime = await readFile(resolve(distributionDirectory, "agent.js"), "utf8");
const indexTypes = await readFile(resolve(distributionDirectory, "index.d.ts"), "utf8");
const indexRuntime = await readFile(resolve(distributionDirectory, "index.js"), "utf8");
const runtimeUpdateTypes = await readFile(resolve(distributionDirectory, "runtime-update.d.ts"), "utf8");
const runtimeUpdateRuntime = await readFile(resolve(distributionDirectory, "runtime-update.js"), "utf8");
const workroomTypes = await readFile(resolve(distributionDirectory, "workrooms.d.ts"), "utf8");
const workroomRuntime = await readFile(resolve(distributionDirectory, "workrooms.js"), "utf8");

for (const expected of [
  "token?: string",
  "isSupervisor: boolean",
  "routing:",
  'mode: "REPLY" | "RELAY"',
  "relay(text: string): Promise<string>",
  "markRead(): Promise<void>",
  "sendWithDetails(recipientHandle: string, text: string): Promise<SentMessage>",
  "sendInConversation(recipientHandle: string, text: string, conversationId: string): Promise<string>",
  "runtime?: AgentRuntimeOptions",
  "get runtimeMetadata(): AgentRuntimeCheckIn",
  "get runtimeUpdate(): RuntimeUpdateAdvisory | undefined",
  "checkForRuntimeUpdate(): Promise<RuntimeUpdateAdvisory | undefined>",
  'on(event: "update", handler: RuntimeUpdateHandler): this',
]) {
  if (!types.includes(expected)) throw new Error(`Node SDK package is missing public API: ${expected}`);
}

for (const expected of [
  "/v1/agent-runtime/supervisors",
  "/v1/agent-runtime/check-in",
  "encodeAgentActivity",
  "Only supervisor messages can be relayed",
  "persistRuntimeUpdateStatus",
]) {
  if (!runtime.includes(expected)) throw new Error(`Node SDK package is missing runtime behavior: ${expected}`);
}

for (const expected of [
  "ATALK_PROTOCOL_VERSION",
  "ATALK_SDK_VERSION",
  "isManagedRuntimeProcess",
  "parseRuntimeUpdateAdvisory",
  "persistRuntimeUpdateStatus",
  "resolveRuntimeCheckIn",
  "AgentRuntimeCheckIn",
  "AgentRuntimeOptions",
  "PersistedRuntimeUpdateStatus",
  "RuntimeComponentMetadata",
  "RuntimeReleaseChannel",
  "RuntimeUpdateAdvisory",
  "RuntimeUpdatePolicy",
  "RuntimeUpdateSeverity",
  "RuntimeUpdateStatus",
]) {
  if (!indexTypes.includes(expected)) throw new Error(`Node SDK package is missing runtime-update export: ${expected}`);
}
for (const expected of [
  "ATALK_PROTOCOL_VERSION",
  "ATALK_SDK_VERSION",
  "isManagedRuntimeProcess",
  "parseRuntimeUpdateAdvisory",
  "persistRuntimeUpdateStatus",
  "resolveRuntimeCheckIn",
]) {
  if (!indexRuntime.includes(expected)) throw new Error(`Node SDK package is missing runtime-update runtime export: ${expected}`);
}
for (const expected of [
  "export declare const ATALK_SDK_VERSION",
  "export declare const ATALK_PROTOCOL_VERSION",
  "export type RuntimeReleaseChannel",
  "export type RuntimeUpdateStatus",
  "export type RuntimeUpdateSeverity",
  "export type RuntimeUpdatePolicy",
  "export interface RuntimeComponentMetadata",
  "export interface AgentRuntimeOptions",
  "export interface AgentRuntimeCheckIn",
  "export interface RuntimeUpdateAdvisory",
  "export interface PersistedRuntimeUpdateStatus",
  "export declare function resolveRuntimeCheckIn",
  "export declare function parseRuntimeUpdateAdvisory",
  "export declare function persistRuntimeUpdateStatus",
  "export declare function isManagedRuntimeProcess",
]) {
  if (!runtimeUpdateTypes.includes(expected)) throw new Error(`Node SDK package is missing runtime-update type surface: ${expected}`);
}
for (const expected of [
  "export const ATALK_SDK_VERSION",
  "export const ATALK_PROTOCOL_VERSION",
  "export function resolveRuntimeCheckIn",
  "export function parseRuntimeUpdateAdvisory",
  "export async function persistRuntimeUpdateStatus",
  "export function isManagedRuntimeProcess",
]) {
  if (!runtimeUpdateRuntime.includes(expected)) throw new Error(`Node SDK package is missing runtime-update implementation: ${expected}`);
}

for (const expected of ["WorkroomClient", "MandatedExecutionResult", "DecryptedWorkroomEvent"]) {
  if (!indexTypes.includes(expected)) throw new Error(`Node SDK package is missing Task export: ${expected}`);
}
for (const expected of [
  "directedToMe: boolean",
  "readAuditEvents(",
  "publishMandated(",
  "submitFileMandated(",
  "executeMandatedAction<T>",
]) {
  if (!workroomTypes.includes(expected)) throw new Error(`Node SDK package is missing Task API: ${expected}`);
}
for (const expected of ["decrypted.directedToMe", "evaluateMandateUse", "signWorkroomReceipt"]) {
  if (!workroomRuntime.includes(expected)) throw new Error(`Node SDK package is missing Task runtime boundary: ${expected}`);
}

console.log("Verified packaged Node direct-message and governed Task APIs");

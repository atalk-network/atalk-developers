import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ATALK_SDK_VERSION = "0.1.0-alpha.14" as const;
export const ATALK_PROTOCOL_VERSION = 1 as const;

export type RuntimeReleaseChannel = "STABLE" | "PREVIEW";
export type RuntimeUpdateStatus = "CURRENT" | "UPDATE_AVAILABLE" | "UPDATE_REQUIRED" | "UNKNOWN";
export type RuntimeUpdateSeverity = "INFO" | "SECURITY" | "INCOMPATIBLE";
export type RuntimeUpdatePolicy = "NOTIFY" | "SECURITY" | "COMPATIBLE";

export interface RuntimeComponentMetadata {
  name: string;
  version: string;
}

export interface AgentRuntimeOptions {
  /** The adapter embedding the SDK. Defaults to a custom SDK integration. */
  integration?: RuntimeComponentMetadata;
  /** Optional host process, for example OpenClaw. */
  host?: RuntimeComponentMetadata;
  channel?: RuntimeReleaseChannel;
  capabilities?: readonly string[];
  /** Persist update state for an external supervisor. `false` disables it. */
  updateStatusPath?: string | false;
  /** Advisory request deadline. Defaults to 5 seconds. */
  checkInTimeoutMs?: number;
}

export interface AgentRuntimeCheckIn {
  sdk: RuntimeComponentMetadata;
  integration: RuntimeComponentMetadata;
  host?: RuntimeComponentMetadata;
  protocolVersion: typeof ATALK_PROTOCOL_VERSION;
  channel: RuntimeReleaseChannel;
  capabilities: string[];
}

export interface RuntimeUpdateAdvisory {
  status: RuntimeUpdateStatus;
  currentVersion: string;
  recommendedVersion?: string;
  minimumVersion?: string;
  severity: RuntimeUpdateSeverity;
  releaseNotesUrl?: string;
  policy: RuntimeUpdatePolicy;
  checkedAt: string;
}

export interface PersistedRuntimeUpdateStatus {
  version: 1;
  /** Local IPC provenance; older v1 files may omit it and are display-only. */
  writerProcessId?: number;
  writerLaunchId?: string;
  metadata: AgentRuntimeCheckIn;
  advisory: RuntimeUpdateAdvisory;
}

const DEFAULT_CAPABILITIES = [
  "e2ee",
  "text",
  "attachments",
  "directed-mentions",
  "supervision",
  "workrooms",
] as const;

export function resolveRuntimeCheckIn(options: AgentRuntimeOptions | undefined): AgentRuntimeCheckIn {
  return {
    sdk: { name: "@atalk/sdk", version: ATALK_SDK_VERSION },
    integration: normalizeComponent(options?.integration ?? { name: "custom", version: ATALK_SDK_VERSION }),
    ...(options?.host ? { host: normalizeComponent(options.host) } : {}),
    protocolVersion: ATALK_PROTOCOL_VERSION,
    channel: options?.channel ?? "PREVIEW",
    capabilities: normalizeCapabilities(options?.capabilities ?? DEFAULT_CAPABILITIES),
  };
}

export function parseRuntimeUpdateAdvisory(value: unknown): RuntimeUpdateAdvisory | undefined {
  if (!isRecord(value)) return undefined;
  const status = enumValue(value.status, ["CURRENT", "UPDATE_AVAILABLE", "UPDATE_REQUIRED", "UNKNOWN"] as const);
  const severity = enumValue(value.severity, ["INFO", "SECURITY", "INCOMPATIBLE"] as const);
  const policy = enumValue(value.policy, ["NOTIFY", "SECURITY", "COMPATIBLE"] as const);
  const currentVersion = boundedString(value.currentVersion, 1, 80);
  const checkedAt = boundedString(value.checkedAt, 1, 80);
  if (!status || !severity || !policy || !currentVersion || !checkedAt || !Number.isFinite(Date.parse(checkedAt))) {
    return undefined;
  }
  const recommendedVersion = optionalBoundedString(value.recommendedVersion, 80);
  const minimumVersion = optionalBoundedString(value.minimumVersion, 80);
  const releaseNotesUrl = optionalHttpUrl(value.releaseNotesUrl);
  if (value.recommendedVersion !== undefined && !recommendedVersion) return undefined;
  if (value.minimumVersion !== undefined && !minimumVersion) return undefined;
  if (value.releaseNotesUrl !== undefined && !releaseNotesUrl) return undefined;
  return {
    status,
    currentVersion,
    ...(recommendedVersion ? { recommendedVersion } : {}),
    ...(minimumVersion ? { minimumVersion } : {}),
    severity,
    ...(releaseNotesUrl ? { releaseNotesUrl } : {}),
    policy,
    checkedAt,
  };
}

export async function persistRuntimeUpdateStatus(
  path: string,
  metadata: AgentRuntimeCheckIn,
  advisory: RuntimeUpdateAdvisory,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const writerLaunchId = uuidValue(process.env.ATALK_RUNTIME_LAUNCH_ID);
  const body: PersistedRuntimeUpdateStatus = {
    version: 1,
    writerProcessId: process.pid,
    ...(writerLaunchId ? { writerLaunchId } : {}),
    metadata,
    advisory,
  };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** Verify that this process is a direct child of the supervisor holding the lease file. */
export function isManagedRuntimeProcess(
  environment: NodeJS.ProcessEnv = process.env,
  parentPid = process.ppid,
  ipcConnected = process.connected === true && typeof process.send === "function",
): boolean {
  if (!ipcConnected) return false;
  if (environment.ATALK_RUNTIME_MANAGED !== "1" && environment.ATALK_RUNTIME_MANAGER !== "1") return false;
  const leasePath = environment.ATALK_RUNTIME_SUPERVISOR_LEASE;
  const supervisorNonce = uuidValue(environment.ATALK_RUNTIME_SUPERVISOR_NONCE);
  const launchId = uuidValue(environment.ATALK_RUNTIME_LAUNCH_ID);
  if (!leasePath || !supervisorNonce || !launchId) return false;
  try {
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as { pid?: unknown; nonce?: unknown };
    return lease.pid === parentPid && lease.nonce === supervisorNonce;
  } catch {
    return false;
  }
}

function uuidValue(value: unknown): string | undefined {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

function normalizeComponent(component: RuntimeComponentMetadata): RuntimeComponentMetadata {
  const name = boundedString(component.name, 1, 120);
  const version = boundedString(component.version, 1, 64);
  if (!name || !/^[A-Za-z0-9@._/-]+$/u.test(name)
    || !version || !/^\S+$/u.test(version)) {
    throw new Error("Runtime components must match the aTalk check-in schema");
  }
  return { name, version };
}

function normalizeCapabilities(values: readonly string[]): string[] {
  if (values.length > 64) throw new Error("Runtime check-ins support at most 64 capabilities");
  const capabilities = values.map((value) => boundedString(value, 1, 120));
  if (capabilities.some((value) => !value || !/^[A-Za-z0-9._:/-]+$/u.test(value))) {
    throw new Error("Runtime capabilities must match the aTalk check-in schema");
  }
  return [...new Set(capabilities as string[])].sort();
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value) ? value as T[number] : undefined;
}

function boundedString(value: unknown, minimum: number, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : undefined;
}

function optionalBoundedString(value: unknown, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, 1, maximum);
}

function optionalHttpUrl(value: unknown): string | undefined {
  const raw = optionalBoundedString(value, 2_048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

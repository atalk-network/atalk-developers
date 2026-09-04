import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EncryptedEnvelope, IdentityKeyPair, PublicPeer } from "@atalk/protocol";

export interface PendingAgentActivation {
  requestId: string;
  keys: IdentityKeyPair;
}

export interface WorkroomMandateUsage {
  volume: {
    messages: number;
    files: number;
    totalBytes: number;
    actions: number;
    custom: Record<string, number>;
  };
  spend: Record<string, { bucket: string; amountMinor: number }>;
  /** Retry-safe operation ids already charged to this mandate revision. */
  completedOperations?: Record<string, string>;
}

export interface AgentRuntimeState {
  version: 1;
  outbox: EncryptedEnvelope[];
  inbox: EncryptedEnvelope[];
  processedIncoming: Record<string, "DELIVERED" | "READ">;
  counterparties: Record<string, PublicPeer>;
  /** Last successfully handled sequence per workroom. */
  workroomCursors?: Record<string, number>;
  /** Bounded durable dedupe set for replayed workroom events. */
  processedWorkroomEvents?: Record<string, true>;
  /** Runtime-enforced counters, isolated by signed mandate revision. */
  workroomMandateUsage?: Record<string, WorkroomMandateUsage>;
  /** Crash-safe activation data. The one-time activation token is never persisted here. */
  pendingActivation?: PendingAgentActivation;
}

export interface RuntimeStateStore {
  load(): Promise<AgentRuntimeState | undefined>;
  save(state: AgentRuntimeState): Promise<void>;
}

export function emptyRuntimeState(): AgentRuntimeState {
  return {
    version: 1,
    outbox: [],
    inbox: [],
    processedIncoming: {},
    counterparties: {},
    workroomCursors: {},
    processedWorkroomEvents: {},
    workroomMandateUsage: {},
  };
}

export class MemoryRuntimeStateStore implements RuntimeStateStore {
  private state?: AgentRuntimeState;

  async load(): Promise<AgentRuntimeState | undefined> {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async save(state: AgentRuntimeState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class FileRuntimeStateStore implements RuntimeStateStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<AgentRuntimeState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as Partial<AgentRuntimeState>;
      return {
        version: 1,
        outbox: Array.isArray(value.outbox) ? value.outbox : [],
        inbox: Array.isArray(value.inbox) ? value.inbox : [],
        processedIncoming: value.processedIncoming && typeof value.processedIncoming === "object"
          ? value.processedIncoming
          : {},
        counterparties: value.counterparties && typeof value.counterparties === "object"
          ? value.counterparties
          : {},
        workroomCursors: value.workroomCursors && typeof value.workroomCursors === "object"
          ? value.workroomCursors
          : {},
        processedWorkroomEvents: value.processedWorkroomEvents && typeof value.processedWorkroomEvents === "object"
          ? value.processedWorkroomEvents
          : {},
        workroomMandateUsage: value.workroomMandateUsage && typeof value.workroomMandateUsage === "object"
          ? value.workroomMandateUsage
          : {},
        ...(isPendingActivation(value.pendingActivation)
          ? { pendingActivation: value.pendingActivation }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: AgentRuntimeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

function isPendingActivation(value: unknown): value is PendingAgentActivation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingAgentActivation>;
  const keys = candidate.keys as Partial<IdentityKeyPair> | undefined;
  return typeof candidate.requestId === "string"
    && typeof keys?.signingPublicKey === "string"
    && typeof keys.signingSecretKey === "string"
    && typeof keys.encryptionPublicKey === "string"
    && typeof keys.encryptionSecretKey === "string";
}

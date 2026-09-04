import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IncomingMessage } from "@atalk/sdk";

type AttachmentDescriptor = NonNullable<IncomingMessage["attachment"]>["descriptor"];

export interface GatewaySender {
  id: string;
  type: IncomingMessage["sender"]["type"];
  status: IncomingMessage["sender"]["status"];
  handle: string;
  displayName: string;
}

export interface GatewayAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "FILE";
  size: number;
  downloadPath: string;
}

export interface GatewayMessageEvent {
  specVersion: "1.0";
  id: string;
  type: "message.received";
  occurredAt: string;
  data: {
    messageId: string;
    conversationId: string;
    text: string;
    sender: GatewaySender;
    isSupervisor: boolean;
    mentions: IncomingMessage["mentions"];
    isMentioned: boolean;
    attachment?: GatewayAttachment;
  };
  actions: {
    reply: string;
    replyAttachment: string;
    markRead: string;
    /** Explicitly commits consumption when polling with mode=explicit. */
    ack: string;
  };
}

export interface GatewayInboxRecord {
  event: GatewayMessageEvent;
  routing: IncomingMessage["routing"];
  attachmentDescriptor?: AttachmentDescriptor;
}

export interface GatewayInboxStore {
  load(): Promise<GatewayInboxRecord[] | undefined>;
  save(records: readonly GatewayInboxRecord[]): Promise<void>;
}

export class MemoryGatewayInboxStore implements GatewayInboxStore {
  private records?: GatewayInboxRecord[];

  async load(): Promise<GatewayInboxRecord[] | undefined> {
    return this.records ? structuredClone(this.records) : undefined;
  }

  async save(records: readonly GatewayInboxRecord[]): Promise<void> {
    this.records = [...structuredClone(records)];
  }
}

export class FileGatewayInboxStore implements GatewayInboxStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<GatewayInboxRecord[] | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as { records?: unknown };
      return Array.isArray(value.records) ? value.records as GatewayInboxRecord[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(records: readonly GatewayInboxRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

export class GatewayInbox {
  private queued: GatewayInboxRecord[] = [];
  private readonly live = new Map<string, IncomingMessage>();
  private readonly waiters = new Set<() => void>();
  private mutation: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | undefined;
  private initialized = false;

  constructor(
    private readonly capacity = 500,
    private readonly store: GatewayInboxStore = new MemoryGatewayInboxStore(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    const initialization = (async () => {
      this.queued = (await this.store.load()) ?? [];
      this.initialized = true;
    })();
    this.initialization = initialization;
    try {
      await initialization;
    } finally {
      if (this.initialization === initialization) this.initialization = undefined;
    }
  }

  async push(message: IncomingMessage): Promise<void> {
    await this.initialize();
    this.live.set(message.id, message);
    if (this.queued.some((record) => record.event.id === message.id)) return;
    await this.mutate((records) => {
      if (records.some((record) => record.event.id === message.id)) return;
      if (records.length >= this.capacity) {
        throw new Error(`GATEWAY_INBOX_FULL: Durable inbox capacity ${this.capacity} was reached`);
      }
      records.push(recordGatewayMessage(message));
    });
    while (this.live.size > this.capacity * 2) {
      const oldest = this.live.keys().next().value as string | undefined;
      if (!oldest) break;
      this.live.delete(oldest);
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  get(id: string): IncomingMessage | undefined {
    return this.live.get(id);
  }

  getRecord(id: string): GatewayInboxRecord | undefined {
    return this.queued.find((record) => record.event.id === id);
  }

  get pending(): number {
    return this.queued.length;
  }

  /** Backward-compatible destructive poll. */
  async take(limit: number, waitSeconds: number): Promise<GatewayInboxRecord[]> {
    await this.waitForEvent(waitSeconds);
    let taken: GatewayInboxRecord[] = [];
    await this.mutate((records) => {
      taken = records.splice(0, limit);
    });
    return taken;
  }

  /** Non-destructive poll. Events remain pending until ack() succeeds. */
  async peek(limit: number, waitSeconds: number): Promise<GatewayInboxRecord[]> {
    await this.waitForEvent(waitSeconds);
    return this.queued.slice(0, limit);
  }

  async ack(id: string): Promise<boolean> {
    let acknowledged = false;
    await this.mutate((records) => {
      const index = records.findIndex((record) => record.event.id === id);
      if (index >= 0) {
        records.splice(index, 1);
        acknowledged = true;
      }
    });
    if (acknowledged) this.live.delete(id);
    return acknowledged;
  }

  private async waitForEvent(waitSeconds: number): Promise<void> {
    await this.initialize();
    if (this.queued.length === 0 && waitSeconds > 0) {
      await new Promise<void>((resolveWait) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolveWait();
        };
        const timer = setTimeout(wake, waitSeconds * 1_000);
        this.waiters.add(wake);
      });
    }
  }

  private async mutate(mutator: (records: GatewayInboxRecord[]) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const next = structuredClone(this.queued);
      mutator(next);
      await this.store.save(next);
      this.queued = next;
    });
    this.mutation = operation.catch(() => undefined);
    return operation;
  }
}

export function recordGatewayMessage(message: IncomingMessage): GatewayInboxRecord {
  return {
    event: serializeGatewayMessage(message),
    routing: message.routing,
    ...(message.attachment ? { attachmentDescriptor: message.attachment.descriptor } : {}),
  };
}

export function serializeGatewayMessage(message: IncomingMessage): GatewayMessageEvent {
  const basePath = `/v1/messages/${encodeURIComponent(message.id)}`;
  const descriptor = message.attachment?.descriptor;
  return {
    specVersion: "1.0",
    id: message.id,
    type: "message.received",
    occurredAt: message.receivedAt.toISOString(),
    data: {
      messageId: message.id,
      conversationId: message.conversationId,
      text: message.text,
      sender: {
        id: message.sender.id,
        type: message.sender.type,
        status: message.sender.status,
        handle: message.sender.handle,
        displayName: message.sender.displayName,
      },
      isSupervisor: message.isSupervisor,
      mentions: message.mentions ?? [],
      isMentioned: message.isMentioned ?? false,
      ...(descriptor ? {
        attachment: {
          id: descriptor.id,
          name: descriptor.name,
          mimeType: descriptor.mimeType,
          kind: descriptor.mimeType.toLowerCase().startsWith("audio/") ? "AUDIO" : descriptor.kind,
          size: descriptor.size,
          downloadPath: `${basePath}/attachment`,
        },
      } : {}),
    },
    actions: {
      reply: `${basePath}/reply`,
      replyAttachment: `${basePath}/reply/attachment`,
      markRead: `${basePath}/read`,
      ack: `${basePath}/ack`,
    },
  };
}

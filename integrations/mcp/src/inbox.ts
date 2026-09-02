import type { IncomingMessage } from "@atalk/sdk";

export interface SerializableMessage {
  id: string;
  conversationId: string;
  text: string;
  sender: IncomingMessage["sender"];
  receivedAt: string;
  isSupervisor: boolean;
  attachment?: { id: string; name: string; mimeType: string; kind: "IMAGE" | "VIDEO" | "FILE"; size: number };
}

export class AgentInbox {
  private readonly queued: IncomingMessage[] = [];
  private readonly known = new Map<string, IncomingMessage>();
  private readonly waiters = new Set<() => void>();

  constructor(private readonly capacity = 500) {}

  push(message: IncomingMessage): void {
    this.known.set(message.id, message);
    this.queued.push(message);
    while (this.queued.length > this.capacity) this.queued.shift();
    while (this.known.size > this.capacity * 2) {
      const oldest = this.known.keys().next().value as string | undefined;
      if (!oldest) break;
      this.known.delete(oldest);
    }
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  get(id: string): IncomingMessage | undefined { return this.known.get(id); }
  get pending(): number { return this.queued.length; }

  async take(limit: number, waitSeconds: number): Promise<IncomingMessage[]> {
    if (this.queued.length === 0 && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, waitSeconds * 1_000);
        const wake = () => { clearTimeout(timer); resolve(); };
        this.waiters.add(wake);
      });
    }
    return this.queued.splice(0, limit);
  }
}

export function serializeMessage(message: IncomingMessage): SerializableMessage {
  const descriptor = message.attachment?.descriptor;
  return {
    id: message.id,
    conversationId: message.conversationId,
    text: message.text,
    sender: message.sender,
    receivedAt: message.receivedAt.toISOString(),
    isSupervisor: message.isSupervisor,
    ...(descriptor ? { attachment: {
      id: descriptor.id,
      name: descriptor.name,
      mimeType: descriptor.mimeType,
      kind: descriptor.kind,
      size: descriptor.size,
    } } : {}),
  };
}

import type { IncomingMessage } from "@atalk/sdk";

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
    attachment?: GatewayAttachment;
  };
  actions: {
    reply: string;
    replyAttachment: string;
    markRead: string;
  };
}

export class GatewayInbox {
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

  get(id: string): IncomingMessage | undefined {
    return this.known.get(id);
  }

  get pending(): number {
    return this.queued.length;
  }

  async take(limit: number, waitSeconds: number): Promise<IncomingMessage[]> {
    if (this.queued.length === 0 && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, waitSeconds * 1_000);
        this.waiters.add(wake);
      });
    }
    return this.queued.splice(0, limit);
  }
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
    },
  };
}

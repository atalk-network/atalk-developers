import { randomUUID } from "node:crypto";
import {
  encodeAgentActivity,
  serverFrameSchema,
  type EncryptedEnvelope,
  type PublicPeer,
  type ServerFrame,
} from "@atalk/protocol";
import WebSocket from "ws";
import { FileCredentialStore, type AgentCredentials, type CredentialStore } from "./credential-store.js";
import { decryptTextNative, encryptTextNative, generateIdentityKeysNative } from "./native-core.js";

export interface AgentOptions {
  token: string;
  baseUrl?: string;
  credentialStore?: CredentialStore;
  credentialPath?: string;
  supervision?: boolean;
}

export interface IncomingMessage {
  id: string;
  conversationId: string;
  text: string;
  sender: PublicPeer;
  receivedAt: Date;
  isSupervisor: boolean;
  reply(text: string): Promise<void>;
  relay(text: string): Promise<void>;
}

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

export class Agent {
  private readonly baseUrl: string;
  private readonly activationToken: string;
  private readonly credentialStore: CredentialStore;
  private readonly supervisionEnabled: boolean;
  private credentials?: AgentCredentials;
  private socket?: WebSocket;
  private stopped = false;
  private messageHandler?: MessageHandler;
  private errorHandler?: ErrorHandler;
  private supervisors: PublicPeer[] = [];
  private readonly counterparties = new Map<string, PublicPeer>();

  constructor(options: AgentOptions) {
    this.activationToken = options.token;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4001").replace(/\/$/u, "");
    this.credentialStore = options.credentialStore ?? new FileCredentialStore(options.token, options.credentialPath);
    this.supervisionEnabled = options.supervision ?? true;
  }

  on(event: "message", handler: MessageHandler): this;
  on(event: "error", handler: ErrorHandler): this;
  on(event: "message" | "error", handler: MessageHandler | ErrorHandler): this {
    if (event === "message") this.messageHandler = handler as MessageHandler;
    else this.errorHandler = handler as ErrorHandler;
    return this;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.credentials = (await this.credentialStore.load()) ?? (await this.activate());
    if (this.supervisionEnabled) {
      const result = await this.request<{ supervisors: PublicPeer[] }>("/v1/agent-runtime/supervisors");
      this.supervisors = result.supervisors;
    }
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close(1000, "Agent stopped");
  }

  async send(recipientHandle: string, text: string): Promise<string> {
    const conversationId = randomUUID();
    await this.sendEnvelope(recipientHandle, text, conversationId);
    return conversationId;
  }

  private async activate(): Promise<AgentCredentials> {
    const keys = generateIdentityKeysNative();
    const response = await this.request<{ token: string; peer: PublicPeer }>("/v1/agents/activate", {
      method: "POST",
      body: JSON.stringify({
        activationToken: this.activationToken,
        signingPublicKey: keys.signingPublicKey,
        encryptionPublicKey: keys.encryptionPublicKey,
      }),
    }, false);
    const credentials = { sessionToken: response.token, peer: response.peer, keys };
    await this.credentialStore.save(credentials);
    return credentials;
  }

  private async connect(): Promise<void> {
    const credentials = this.requireCredentials();
    const websocketUrl = `${this.baseUrl.replace(/^http/u, "ws")}/v1/ws`;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(websocketUrl);
      this.socket = socket;
      let ready = false;
      const timeout = setTimeout(() => {
        if (!ready) {
          socket.close();
          reject(new Error("aTalk connection timed out"));
        }
      }, 10_000);

      socket.on("open", () => socket.send(JSON.stringify({ kind: "AUTH", token: credentials.sessionToken })));
      socket.on("message", (raw) => {
        const frame = serverFrameSchema.parse(JSON.parse(raw.toString()));
        void this.handleFrame(frame).then(() => {
          if (frame.kind === "READY" && !ready && this.socket === socket) {
            ready = true;
            clearTimeout(timeout);
            resolve();
          }
        }).catch((error: unknown) => {
          if (!ready) {
            clearTimeout(timeout);
            reject(error);
            socket.close();
          } else {
            this.emitError(error);
          }
        });
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        if (!ready) reject(error);
        else this.emitError(error);
      });
      socket.on("close", (code) => {
        clearTimeout(timeout);
        if (!ready) {
          reject(new Error(code === 4001 || code === 1008 ? "INVALID_SESSION: Agent credentials were revoked" : "aTalk connection closed before authentication"));
          return;
        }
        if (code === 4001 || code === 1008) {
          this.stopped = true;
          this.emitError(new Error("INVALID_SESSION: Agent credentials were revoked"));
          return;
        }
        if (!this.stopped && ready) setTimeout(() => void this.connect().catch((error) => this.emitError(error)), 1_000);
      });
    });
  }

  private async handleFrame(frame: ServerFrame): Promise<void> {
    if (frame.kind === "ERROR") throw new Error(`${frame.code}: ${frame.message}`);
    if (frame.kind === "RECEIPT") {
      this.sendFrame({ kind: "RECEIPT_ACK", messageId: frame.messageId, state: frame.state });
      return;
    }
    if (frame.kind !== "MESSAGE") return;
    const credentials = this.requireCredentials();
    const sender = await this.request<PublicPeer>(`/v1/peers/${frame.envelope.sender_peer_id}/keys`);
    const text = decryptTextNative({
      envelope: frame.envelope,
      senderSigningPublicKey: sender.signingPublicKey,
      senderEncryptionPublicKey: sender.encryptionPublicKey,
      recipientEncryptionSecretKey: credentials.keys.encryptionSecretKey,
    });
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === sender.id);
    if (!isSupervisor) {
      this.counterparties.set(frame.envelope.conversation_id, sender);
      await this.mirrorActivity("INCOMING", sender, text, frame.envelope.conversation_id, frame.envelope.message_id, frame.envelope.timestamp);
    }
    this.sendFrame({ kind: "ACK", messageId: frame.envelope.message_id, state: "DELIVERED" });
    if (this.messageHandler) {
      await this.messageHandler({
        id: frame.envelope.message_id,
        conversationId: frame.envelope.conversation_id,
        text,
        sender,
        receivedAt: new Date(frame.envelope.timestamp),
        isSupervisor,
        reply: async (replyText) => {
          await this.sendEnvelope(sender.handle, replyText, frame.envelope.conversation_id);
        },
        relay: async (relayText) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          const counterparty = this.counterparties.get(frame.envelope.conversation_id);
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          await this.sendEnvelope(counterparty.handle, relayText, frame.envelope.conversation_id);
        },
      });
    }
  }

  private async sendEnvelope(recipientHandle: string, text: string, conversationId: string): Promise<string> {
    const credentials = this.requireCredentials();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Agent is not connected");
    const { recipient } = await this.request<{ recipient: PublicPeer }>("/v1/messages/authorize", {
      method: "POST",
      body: JSON.stringify({ recipientHandle }),
    });
    const envelope: EncryptedEnvelope = encryptTextNative({
      messageId: randomUUID(),
      conversationId,
      senderPeerId: credentials.peer.id,
      recipientPeerId: recipient.id,
      timestamp: new Date().toISOString(),
      plaintext: text,
      senderSigningSecretKey: credentials.keys.signingSecretKey,
      senderEncryptionSecretKey: credentials.keys.encryptionSecretKey,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
    });
    this.sendFrame({ kind: "DELIVER", envelope });
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === recipient.id);
    if (!isSupervisor) {
      this.counterparties.set(conversationId, recipient);
      await this.mirrorActivity("OUTGOING", recipient, text, conversationId, envelope.message_id, envelope.timestamp);
    }
    return envelope.message_id;
  }

  private async mirrorActivity(
    direction: "INCOMING" | "OUTGOING",
    counterparty: PublicPeer,
    text: string,
    conversationId: string,
    sourceMessageId: string,
    observedAt: string,
  ): Promise<void> {
    if (!this.supervisionEnabled || this.supervisors.length === 0) return;
    const credentials = this.requireCredentials();
    const plaintext = encodeAgentActivity({
      version: 1,
      kind: "AGENT_ACTIVITY",
      agentPeerId: credentials.peer.id,
      agentHandle: credentials.peer.handle,
      counterpartyPeerId: counterparty.id,
      counterpartyHandle: counterparty.handle,
      counterpartyDisplayName: counterparty.displayName,
      direction,
      sourceMessageId,
      observedAt,
      text,
    });
    for (const supervisor of this.supervisors) {
      const envelope = encryptTextNative({
        messageId: randomUUID(),
        conversationId,
        senderPeerId: credentials.peer.id,
        recipientPeerId: supervisor.id,
        timestamp: new Date().toISOString(),
        plaintext,
        senderSigningSecretKey: credentials.keys.signingSecretKey,
        senderEncryptionSecretKey: credentials.keys.encryptionSecretKey,
        recipientEncryptionPublicKey: supervisor.encryptionPublicKey,
      });
      this.sendFrame({ kind: "DELIVER", envelope });
    }
  }

  private sendFrame(frame: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Agent is not connected");
    this.socket.send(JSON.stringify(frame));
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const credentials = this.credentials;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(authenticated && credentials ? { authorization: `Bearer ${credentials.sessionToken}` } : {}),
        ...init.headers,
      },
    });
    const body = await response.json() as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${response.status}`);
    return body;
  }

  private requireCredentials(): AgentCredentials {
    if (!this.credentials) throw new Error("Agent has not been started");
    return this.credentials;
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.errorHandler) this.errorHandler(normalized);
    else queueMicrotask(() => { throw normalized; });
  }
}

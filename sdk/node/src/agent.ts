import { randomUUID } from "node:crypto";
import {
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
}

export interface IncomingMessage {
  id: string;
  conversationId: string;
  text: string;
  sender: PublicPeer;
  receivedAt: Date;
  reply(text: string): Promise<void>;
}

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

export class Agent {
  private readonly baseUrl: string;
  private readonly activationToken: string;
  private readonly credentialStore: CredentialStore;
  private credentials?: AgentCredentials;
  private socket?: WebSocket;
  private stopped = false;
  private messageHandler?: MessageHandler;
  private errorHandler?: ErrorHandler;

  constructor(options: AgentOptions) {
    this.activationToken = options.token;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4001").replace(/\/$/u, "");
    this.credentialStore = options.credentialStore ?? new FileCredentialStore(options.token, options.credentialPath);
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
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close(1000, "Agent stopped");
  }

  async send(recipientHandle: string, text: string): Promise<string> {
    return this.sendEnvelope(recipientHandle, text, randomUUID());
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
        void this.handleFrame(serverFrameSchema.parse(JSON.parse(raw.toString()))).then(() => {
          if (!ready && this.socket === socket) {
            ready = true;
            clearTimeout(timeout);
            resolve();
          }
        }).catch((error: unknown) => this.emitError(error));
      });
      socket.on("error", (error) => {
        clearTimeout(timeout);
        if (!ready) reject(error);
        else this.emitError(error);
      });
      socket.on("close", () => {
        clearTimeout(timeout);
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
    this.sendFrame({ kind: "ACK", messageId: frame.envelope.message_id, state: "DELIVERED" });
    if (this.messageHandler) {
      await this.messageHandler({
        id: frame.envelope.message_id,
        conversationId: frame.envelope.conversation_id,
        text,
        sender,
        receivedAt: new Date(frame.envelope.timestamp),
        reply: async (replyText) => {
          await this.sendEnvelope(sender.handle, replyText, frame.envelope.conversation_id);
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
    return envelope.message_id;
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

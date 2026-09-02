import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import {
  decodeAttachmentMessage,
  decryptAttachment,
  attachmentPartDescriptors,
  encodeAgentActivity,
  encodeAttachmentMessage,
  encryptAttachment,
  joinEncryptedAttachmentParts,
  serverFrameSchema,
  splitEncryptedAttachment,
  type AttachmentDescriptor,
  type EncryptedEnvelope,
  type PublicPeer,
  type ServerFrame,
} from "@atalk/protocol";
import WebSocket from "ws";
import { FileCredentialStore, type AgentCredentials, type CredentialStore } from "./credential-store.js";
import { decryptTextNative, encryptTextNative, generateIdentityKeysNative } from "./native-core.js";

export interface AgentOptions {
  /** One-time activation token. Optional after credentials have been persisted. */
  token?: string;
  baseUrl?: string;
  credentialStore?: CredentialStore;
  credentialPath?: string;
  supervision?: boolean;
}

export interface IncomingMessage {
  id: string;
  conversationId: string;
  text: string;
  attachment?: IncomingAttachment;
  sender: PublicPeer;
  receivedAt: Date;
  isSupervisor: boolean;
  reply(text: string): Promise<string>;
  replyAttachment(input: AgentAttachmentInput): Promise<string>;
  replyAttachmentFile(input: AgentAttachmentFileInput): Promise<string>;
  relay(text: string): Promise<string>;
  relayAttachment(input: AgentAttachmentInput): Promise<string>;
  relayAttachmentFile(input: AgentAttachmentFileInput): Promise<string>;
  markRead(): Promise<void>;
}

export interface AgentAttachmentInput {
  data: Uint8Array;
  name: string;
  mimeType?: string;
  caption?: string;
}

export interface AgentAttachmentFileInput {
  path: string;
  name?: string;
  mimeType?: string;
  caption?: string;
}

export interface IncomingAttachment {
  descriptor: AttachmentDescriptor;
  download(): Promise<Uint8Array>;
  /** Decrypt and save the attachment to an explicit local path. */
  downloadTo(filePath: string): Promise<string>;
}

export interface SentMessage {
  conversationId: string;
  messageId: string;
}

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

export class Agent {
  private readonly baseUrl: string;
  private readonly activationToken: string | undefined;
  private readonly credentialStore: CredentialStore;
  private readonly supervisionEnabled: boolean;
  private credentials?: AgentCredentials;
  private socket?: WebSocket;
  private ready = false;
  private reconnectAttempt = 0;
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

  get connected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  get peer(): PublicPeer | undefined {
    return this.credentials?.peer;
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
    this.ready = false;
    this.reconnectAttempt = 0;
    this.socket?.close(1000, "Agent stopped");
  }

  async send(recipientHandle: string, text: string): Promise<string> {
    return (await this.sendWithDetails(recipientHandle, text)).conversationId;
  }

  /** Start a conversation and return both transport identifiers. */
  async sendWithDetails(recipientHandle: string, text: string): Promise<SentMessage> {
    const conversationId = randomUUID();
    const messageId = await this.sendEnvelope(recipientHandle, text, conversationId);
    return { conversationId, messageId };
  }

  /** Send inside a known conversation and return the new message id. */
  async sendInConversation(recipientHandle: string, text: string, conversationId: string): Promise<string> {
    return this.sendEnvelope(recipientHandle, text, conversationId);
  }

  async sendAttachment(recipientHandle: string, input: AgentAttachmentInput): Promise<string> {
    return (await this.sendAttachmentWithDetails(recipientHandle, input)).conversationId;
  }

  async sendAttachmentWithDetails(recipientHandle: string, input: AgentAttachmentInput): Promise<SentMessage> {
    const conversationId = randomUUID();
    const messageId = await this.sendAttachmentEnvelope(recipientHandle, input, conversationId);
    return { conversationId, messageId };
  }

  async sendAttachmentFile(recipientHandle: string, input: AgentAttachmentFileInput): Promise<string> {
    return (await this.sendAttachmentFileWithDetails(recipientHandle, input)).conversationId;
  }

  async sendAttachmentFileWithDetails(
    recipientHandle: string,
    input: AgentAttachmentFileInput,
  ): Promise<SentMessage> {
    return this.sendAttachmentWithDetails(recipientHandle, await attachmentInputFromFile(input));
  }

  async sendAttachmentInConversation(
    recipientHandle: string,
    input: AgentAttachmentInput,
    conversationId: string,
  ): Promise<string> {
    return this.sendAttachmentEnvelope(recipientHandle, input, conversationId);
  }

  async sendAttachmentFileInConversation(
    recipientHandle: string,
    input: AgentAttachmentFileInput,
    conversationId: string,
  ): Promise<string> {
    return this.sendAttachmentInConversation(recipientHandle, await attachmentInputFromFile(input), conversationId);
  }

  private async activate(): Promise<AgentCredentials> {
    if (!this.activationToken) {
      throw new Error("ACTIVATION_REQUIRED: Provide a one-time token because no persisted credentials were found");
    }
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
    this.ready = false;
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
            this.ready = true;
            this.reconnectAttempt = 0;
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
        if (this.socket === socket) this.ready = false;
        if (!ready) {
          const error = new Error(code === 4001 || code === 1008 ? "INVALID_SESSION: Agent credentials were revoked" : "aTalk connection closed before authentication");
          if (code === 4001 || code === 1008) this.stopped = true;
          reject(error);
          return;
        }
        if (code === 4001 || code === 1008) {
          this.stopped = true;
          this.emitError(new Error("INVALID_SESSION: Agent credentials were revoked"));
          return;
        }
        if (!this.stopped && ready) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = reconnectDelay(this.reconnectAttempt++);
    setTimeout(() => {
      if (this.stopped) return;
      void this.connect().catch((error: unknown) => {
        this.emitError(error);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
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
    const attachmentMessage = decodeAttachmentMessage(text);
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
        text: attachmentMessage?.caption ?? (attachmentMessage ? "" : text),
        ...(attachmentMessage ? { attachment: {
          descriptor: attachmentMessage.attachment,
          download: () => this.downloadAttachment(attachmentMessage.attachment),
          downloadTo: (filePath) => this.downloadAttachmentToFile(attachmentMessage.attachment, filePath),
        } } : {}),
        sender,
        receivedAt: new Date(frame.envelope.timestamp),
        isSupervisor,
        reply: (replyText) => this.sendEnvelope(sender.handle, replyText, frame.envelope.conversation_id),
        replyAttachment: (input) => this.sendAttachmentEnvelope(sender.handle, input, frame.envelope.conversation_id),
        replyAttachmentFile: async (input) => this.sendAttachmentEnvelope(
          sender.handle,
          await attachmentInputFromFile(input),
          frame.envelope.conversation_id,
        ),
        relay: async (relayText) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          const counterparty = this.counterparties.get(frame.envelope.conversation_id);
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          return this.sendEnvelope(counterparty.handle, relayText, frame.envelope.conversation_id);
        },
        relayAttachment: async (input) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          const counterparty = this.counterparties.get(frame.envelope.conversation_id);
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          return this.sendAttachmentEnvelope(counterparty.handle, input, frame.envelope.conversation_id);
        },
        relayAttachmentFile: async (input) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          const counterparty = this.counterparties.get(frame.envelope.conversation_id);
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          return this.sendAttachmentEnvelope(
            counterparty.handle,
            await attachmentInputFromFile(input),
            frame.envelope.conversation_id,
          );
        },
        markRead: async () => this.sendFrame({ kind: "ACK", messageId: frame.envelope.message_id, state: "READ" }),
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

  private async sendAttachmentEnvelope(
    recipientHandle: string,
    input: AgentAttachmentInput,
    conversationId: string,
  ): Promise<string> {
    const credentials = this.requireCredentials();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Agent is not connected");
    const { recipient } = await this.request<{ recipient: PublicPeer }>("/v1/messages/authorize", {
      method: "POST",
      body: JSON.stringify({ recipientHandle }),
    });
    const encrypted = splitEncryptedAttachment(encryptAttachment({
      id: randomUUID(),
      bytes: input.data,
      name: input.name,
      mimeType: input.mimeType ?? "application/octet-stream",
    }), randomUUID);
    for (const part of encrypted.parts) {
      await this.uploadAttachment(recipient.id, part.id, part.ciphertext);
    }
    const caption = input.caption?.trim();
    const plaintext = encodeAttachmentMessage({
      attachment: encrypted.descriptor,
      ...(caption ? { caption } : {}),
    });
    const envelope: EncryptedEnvelope = encryptTextNative({
      messageId: randomUUID(),
      conversationId,
      senderPeerId: credentials.peer.id,
      recipientPeerId: recipient.id,
      timestamp: new Date().toISOString(),
      plaintext,
      senderSigningSecretKey: credentials.keys.signingSecretKey,
      senderEncryptionSecretKey: credentials.keys.encryptionSecretKey,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
    });
    this.sendFrame({ kind: "DELIVER", envelope });
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === recipient.id);
    if (!isSupervisor) {
      this.counterparties.set(conversationId, recipient);
      await this.mirrorActivity("OUTGOING", recipient, plaintext, conversationId, envelope.message_id, envelope.timestamp);
    }
    return envelope.message_id;
  }

  private async uploadAttachment(
    recipientPeerId: string,
    attachmentId: string,
    ciphertext: Uint8Array,
  ): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/v1/attachments/${attachmentId}?recipientPeerId=${encodeURIComponent(recipientPeerId)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.requireCredentials().sessionToken}`,
          "content-type": "application/octet-stream",
        },
        body: exactArrayBuffer(ciphertext),
      },
    );
    if (!response.ok) throw await responseError(response);
  }

  private async downloadAttachment(descriptor: AttachmentDescriptor): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (const part of attachmentPartDescriptors(descriptor)) {
      const response = await fetch(`${this.baseUrl}/v1/attachments/${part.id}`, {
        headers: { authorization: `Bearer ${this.requireCredentials().sessionToken}` },
      });
      if (!response.ok) throw await responseError(response);
      parts.push(new Uint8Array(await response.arrayBuffer()));
    }
    return decryptAttachment(joinEncryptedAttachmentParts(parts, descriptor), descriptor);
  }

  private async downloadAttachmentToFile(descriptor: AttachmentDescriptor, filePath: string): Promise<string> {
    const target = resolve(filePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await this.downloadAttachment(descriptor), { mode: 0o600 });
    return target;
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

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function attachmentInputFromFile(input: AgentAttachmentFileInput): Promise<AgentAttachmentInput> {
  const path = resolve(input.path);
  return {
    data: new Uint8Array(await readFile(path)),
    name: input.name?.trim() || basename(path),
    mimeType: input.mimeType?.trim() || mimeTypeFromPath(path),
    ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}),
  };
}

function mimeTypeFromPath(path: string): string {
  const mimeTypes: Record<string, string> = {
    ".aac": "audio/aac", ".csv": "text/csv", ".gif": "image/gif", ".heic": "image/heic",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json", ".m4a": "audio/mp4",
    ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ogg": "audio/ogg",
    ".pdf": "application/pdf", ".png": "image/png", ".txt": "text/plain", ".wav": "audio/wav",
    ".webm": "video/webm", ".webp": "image/webp", ".zip": "application/zip",
  };
  return mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream";
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    if (body.error) return new Error(`${body.error.code ?? response.status}: ${body.error.message ?? "request failed"}`);
  } catch {
    // Keep the HTTP fallback for non-JSON proxy responses.
  }
  return new Error(`HTTP ${response.status}`);
}

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
  return exponential + Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.2)));
}

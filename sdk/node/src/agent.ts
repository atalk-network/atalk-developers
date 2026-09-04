import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import {
  decodeAttachmentMessage,
  createChunkedAttachmentDescriptor,
  decryptAttachmentChunk,
  decodeDirectedMessage,
  decryptAttachment,
  attachmentPartDescriptors,
  encodeAgentActivity,
  encodeAttachmentMessage,
  encryptAttachment,
  encryptAttachmentChunk,
  joinEncryptedAttachmentParts,
  serverFrameSchema,
  splitEncryptedAttachment,
  type AttachmentDescriptor,
  type EncryptedEnvelope,
  type MessageMention,
  type PublicPeer,
  type ServerFrame,
} from "@atalk/protocol";
import WebSocket from "ws";
import {
  FileCredentialStore,
  type AgentCredentials,
  type CredentialRefresher,
  type CredentialStore,
} from "./credential-store.js";
import { decryptTextNative, encryptTextNative, generateIdentityKeysNative } from "./native-core.js";
import {
  emptyRuntimeState,
  FileRuntimeStateStore,
  MemoryRuntimeStateStore,
  type AgentRuntimeState,
  type RuntimeStateStore,
} from "./runtime-state-store.js";
import { WorkroomClient } from "./workrooms.js";

const MAX_PROCESSED_INCOMING = 10_000;
const DEFAULT_REFRESH_LEEWAY_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const FATAL_SESSION_CODES = new Set([
  "AUTH_REQUIRED",
  "INVALID_REFRESH_TOKEN",
  "INVALID_SESSION",
  "PEER_INACTIVE",
]);

export interface AgentOptions {
  /** One-time activation token. Optional after credentials have been persisted. */
  token?: string;
  baseUrl?: string;
  credentialStore?: CredentialStore;
  credentialPath?: string;
  runtimeStateStore?: RuntimeStateStore;
  runtimeStatePath?: string;
  /** Called when refresh-capable credentials are expiring or rejected. */
  refreshCredentials?: CredentialRefresher;
  refreshLeewayMs?: number;
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
  /** Agent mentions authored inside the E2EE payload. */
  mentions: readonly MessageMention[];
  /** True when this runtime identity is explicitly mentioned. */
  isMentioned: boolean;
  reply(text: string): Promise<string>;
  replyAttachment(input: AgentAttachmentInput): Promise<string>;
  replyAttachmentFile(input: AgentAttachmentFileInput): Promise<string>;
  relay(text: string): Promise<string>;
  relayAttachment(input: AgentAttachmentInput): Promise<string>;
  relayAttachmentFile(input: AgentAttachmentFileInput): Promise<string>;
  markRead(): Promise<void>;
  /** Durable routing hint used by bridges that persist an event beyond this process. */
  routing: { mode: "REPLY" | "RELAY"; targetHandle: string };
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
  transfer?: AttachmentTransferOptions;
}

export interface AttachmentTransferProgress {
  phase: "UPLOADING" | "DOWNLOADING";
  bytesTransferred: number;
  totalBytes: number;
  partIndex: number;
  partCount: number;
}

export interface AttachmentTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AttachmentTransferProgress) => void;
  maxAttempts?: number;
}

export interface IncomingAttachment {
  descriptor: AttachmentDescriptor;
  download(): Promise<Uint8Array>;
  /** Decrypt and save the attachment to an explicit local path. */
  downloadTo(filePath: string, options?: AttachmentTransferOptions): Promise<string>;
}

export interface SentMessage {
  conversationId: string;
  messageId: string;
}

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

export class Agent {
  /** Durable, E2EE task/workroom API for this agent identity. */
  readonly workrooms: WorkroomClient;
  private readonly baseUrl: string;
  private readonly activationToken: string | undefined;
  private readonly credentialStore: CredentialStore;
  private readonly runtimeStateStore: RuntimeStateStore;
  private readonly credentialRefresher: CredentialRefresher | undefined;
  private readonly usesDefaultCredentialRefresher: boolean;
  private readonly refreshLeewayMs: number;
  private readonly supervisionEnabled: boolean;
  private credentials?: AgentCredentials;
  private runtimeState: AgentRuntimeState = emptyRuntimeState();
  private stateMutation: Promise<void> = Promise.resolve();
  private refreshPromise: Promise<boolean> | undefined;
  private outboxDrain: Promise<void> | undefined;
  private inboxDrain: Promise<void> | undefined;
  private inboxRetryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private inboxRetryAttempt = 0;
  private readonly sentThisConnection = new Set<string>();
  private socket?: WebSocket;
  private ready = false;
  private reconnectAttempt = 0;
  private stopped = false;
  private messageHandler?: MessageHandler;
  private errorHandler?: ErrorHandler;
  private supervisors: PublicPeer[] = [];
  private readonly counterparties = new Map<string, PublicPeer>();
  private readonly processingIncoming = new Map<string, Promise<void>>();

  constructor(options: AgentOptions) {
    this.activationToken = options.token;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:4001").replace(/\/$/u, "");
    this.credentialStore = options.credentialStore ?? new FileCredentialStore(options.token, options.credentialPath);
    this.runtimeStateStore = options.runtimeStateStore
      ?? (options.runtimeStatePath
        ? new FileRuntimeStateStore(options.runtimeStatePath)
        : this.credentialStore instanceof FileCredentialStore
          ? new FileRuntimeStateStore(`${this.credentialStore.path}.runtime.json`)
          : new MemoryRuntimeStateStore());
    this.usesDefaultCredentialRefresher = !options.refreshCredentials;
    this.credentialRefresher = options.refreshCredentials ?? refreshAtalkCredentials;
    this.refreshLeewayMs = Math.max(0, options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS);
    this.supervisionEnabled = options.supervision ?? true;
    this.workrooms = new WorkroomClient({
      request: <T>(path: string, init?: RequestInit) => this.request<T>(path, init),
      credentials: () => this.requireCredentials(),
      runtimeState: () => this.runtimeState,
      mutateRuntimeState: (mutator) => this.mutateRuntimeState(mutator),
      uploadPart: (scope, id, bytes, transfer) => this.uploadAttachment(scope, id, bytes, transfer),
      deletePart: (id) => this.deleteAttachmentPart(id),
      downloadAttachment: (descriptor) => this.downloadAttachment(descriptor),
      downloadAttachmentTo: (descriptor, path, transfer) => this.downloadAttachmentTo(descriptor, path, transfer),
    });
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
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.inboxRetryAttempt = 0;
    this.runtimeState = (await this.runtimeStateStore.load()) ?? emptyRuntimeState();
    const persistedCredentials = await this.credentialStore.load();
    this.credentials = persistedCredentials ?? (await this.activate());
    this.counterparties.clear();
    for (const [conversationId, peer] of Object.entries(this.runtimeState.counterparties)) {
      this.counterparties.set(conversationId, peer);
    }
    try {
      await this.prepareAndConnect();
    } catch (error) {
      // A newly issued connection code is also the recovery path after an
      // owner revoked this runtime's sessions. Reuse the locally persisted
      // identity keys: silently generating a new pair would strand encrypted
      // Task history and change the agent's cryptographic identity.
      if (!persistedCredentials || !this.activationToken || !isSessionError(error)) throw error;
      this.credentials = await this.activate(persistedCredentials.keys);
      await this.prepareAndConnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    if (this.inboxRetryTimer) clearTimeout(this.inboxRetryTimer);
    this.inboxRetryTimer = undefined;
    this.socket?.close(1000, "Agent stopped");
    await this.stateMutation;
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
    const conversationId = randomUUID();
    const messageId = await this.sendAttachmentFileEnvelope(recipientHandle, input, conversationId);
    return { conversationId, messageId };
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
    return this.sendAttachmentFileEnvelope(recipientHandle, input, conversationId);
  }

  /** Download an attachment descriptor retained by a durable bridge. */
  async downloadAttachment(descriptor: AttachmentDescriptor): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for (const part of attachmentPartDescriptors(descriptor)) {
      const response = await this.authorizedFetch(`${this.baseUrl}/v1/attachments/${part.id}`);
      if (!response.ok) throw await responseError(response);
      parts.push(new Uint8Array(await response.arrayBuffer()));
    }
    return decryptAttachment(joinEncryptedAttachmentParts(parts, descriptor), descriptor);
  }

  /** Stream-decrypt an attachment into an atomic local file without buffering the whole payload. */
  async downloadAttachmentTo(
    descriptor: AttachmentDescriptor,
    filePath: string,
    options?: AttachmentTransferOptions,
  ): Promise<string> {
    return this.downloadAttachmentToFile(descriptor, filePath, options);
  }

  /** Mark an incoming message as read when only its durable id is available. */
  async markMessageRead(messageId: string): Promise<void> {
    await this.completeIncoming(messageId, "READ");
    this.sendFrame({ kind: "ACK", messageId, state: "READ" });
    this.scheduleInboxRetry();
  }

  private async activate(existingKeys?: AgentCredentials["keys"]): Promise<AgentCredentials> {
    if (!this.activationToken) {
      throw new Error("ACTIVATION_REQUIRED: Provide a one-time token because no persisted credentials were found");
    }
    const remembered = this.runtimeState.pendingActivation;
    const pending = remembered && (!existingKeys || sameIdentityKeys(remembered.keys, existingKeys))
      ? remembered
      : {
          requestId: randomUUID(),
          keys: existingKeys ?? generateIdentityKeysNative(),
        };
    if (pending !== remembered) {
      await this.mutateRuntimeState((state) => { state.pendingActivation = pending; });
    }
    const response = await this.request<{
      token: string;
      accessToken?: string;
      refreshToken?: string;
      accessTokenExpiresAt?: string;
      expiresAt?: string;
      peer: PublicPeer;
    }>("/v1/agents/activate", {
      method: "POST",
      body: JSON.stringify({
        activationToken: this.activationToken,
        activationRequestId: pending.requestId,
        signingPublicKey: pending.keys.signingPublicKey,
        encryptionPublicKey: pending.keys.encryptionPublicKey,
      }),
    }, false);
    const access = response.accessToken ?? response.token;
    const accessTokenExpiresAt = response.accessTokenExpiresAt ?? response.expiresAt;
    const credentials: AgentCredentials = {
      sessionToken: access,
      accessToken: access,
      ...(response.refreshToken ? { refreshToken: response.refreshToken } : {}),
      ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
      peer: response.peer,
      keys: pending.keys,
    };
    await this.credentialStore.save(credentials);
    await this.mutateRuntimeState((state) => { delete state.pendingActivation; });
    return credentials;
  }

  private async prepareAndConnect(): Promise<void> {
    await this.refreshCredentialsIfNeeded("EXPIRING");
    if (this.supervisionEnabled) {
      const result = await this.request<{ supervisors: PublicPeer[] }>("/v1/agent-runtime/supervisors");
      this.supervisors = result.supervisors;
    }
    await this.connectWithRefresh();
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

      socket.on("open", () => socket.send(JSON.stringify({ kind: "AUTH", token: accessToken(credentials) })));
      socket.on("message", (raw) => {
        const frame = serverFrameSchema.parse(JSON.parse(raw.toString()));
        void this.handleFrame(frame).then(() => {
          if (frame.kind === "READY" && !ready && this.socket === socket) {
            ready = true;
            this.ready = true;
            this.reconnectAttempt = 0;
            this.sentThisConnection.clear();
            this.startHeartbeat(socket);
            clearTimeout(timeout);
            resolve();
            void this.drainOutbox().catch((error: unknown) => this.emitError(error));
            void this.drainInbox();
          }
        }).catch((error: unknown) => {
          if (!ready) {
            clearTimeout(timeout);
            reject(error);
            socket.close();
          } else {
            this.emitError(error);
            this.scheduleInboxRetry();
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
        if (this.socket === socket) {
          this.ready = false;
          delete this.socket;
          this.stopHeartbeat();
        }
        if (!ready) {
          const error = code === 4001 || code === 1008
            ? new AgentProtocolError("INVALID_SESSION", "Agent credentials were rejected")
            : new Error("aTalk connection closed before authentication");
          reject(error);
          return;
        }
        if (code === 4001 || code === 1008) {
          void this.recoverRejectedSession();
          return;
        }
        if (!this.stopped && ready) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = reconnectDelay(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      void this.connectWithRefresh().catch((error: unknown) => {
        if (isSessionError(error)) this.stopped = true;
        this.emitError(error);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.stopped || !this.ready || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ kind: "PING" }));
      } catch (error) {
        this.emitError(error);
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async handleFrame(frame: ServerFrame): Promise<void> {
    if (frame.kind === "ERROR") {
      throw new AgentProtocolError(frame.code, frame.message);
    }
    if (frame.kind === "RECEIPT") {
      await this.removeFromOutbox(frame.messageId);
      this.sendFrame({ kind: "RECEIPT_ACK", messageId: frame.messageId, state: frame.state });
      return;
    }
    if (frame.kind === "ACK_RECEIVED") {
      await this.forgetIncoming(frame.messageId);
      return;
    }
    if (frame.kind !== "MESSAGE") return;
    const messageId = frame.envelope.message_id;
    const confirmed = this.runtimeState.processedIncoming[messageId];
    if (confirmed) {
      this.sendFrame({ kind: "ACK", messageId, state: confirmed });
      this.scheduleInboxRetry();
      return;
    }
    await this.rememberIncoming(frame.envelope);
    const existing = this.processingIncoming.get(messageId);
    if (existing) {
      await existing;
      return;
    }
    const processing = this.processIncomingMessage(frame);
    this.processingIncoming.set(messageId, processing);
    try {
      await processing;
    } finally {
      this.processingIncoming.delete(messageId);
    }
  }

  private async processIncomingMessage(frame: Extract<ServerFrame, { kind: "MESSAGE" }>): Promise<void> {
    const credentials = this.requireCredentials();
    const sender = await this.request<PublicPeer>(`/v1/messages/${frame.envelope.message_id}/sender-keys`);
    const text = decryptTextNative({
      envelope: frame.envelope,
      senderSigningPublicKey: sender.signingPublicKey,
      senderEncryptionPublicKey: sender.encryptionPublicKey,
      recipientEncryptionSecretKey: credentials.keys.encryptionSecretKey,
    });
    const directedMessage = decodeDirectedMessage(text);
    const content = directedMessage?.content ?? text;
    const attachmentMessage = decodeAttachmentMessage(content);
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === sender.id);
    const isMentioned = directedMessage?.mentions.some((mention) => mention.peerId === credentials.peer.id) ?? false;
    const counterparty = isSupervisor ? this.counterparties.get(frame.envelope.conversation_id) : sender;
    const routing = isSupervisor && !isMentioned && counterparty
      ? { mode: "RELAY" as const, targetHandle: counterparty.handle }
      : { mode: "REPLY" as const, targetHandle: sender.handle };
    if (!isSupervisor) {
      this.counterparties.set(frame.envelope.conversation_id, sender);
      await this.mutateRuntimeState((state) => {
        state.counterparties[frame.envelope.conversation_id] = sender;
      });
      await this.mirrorActivity("INCOMING", sender, text, frame.envelope.conversation_id, frame.envelope.message_id, frame.envelope.timestamp);
    }
    if (!this.messageHandler) throw new Error("MESSAGE_HANDLER_NOT_CONFIGURED: Register a message handler before start()");
    let acknowledgedState: "DELIVERED" | "READ" = "DELIVERED";
    let handlerComplete = false;
    await this.messageHandler({
        id: frame.envelope.message_id,
        conversationId: frame.envelope.conversation_id,
        text: attachmentMessage?.caption ?? (attachmentMessage ? "" : content),
        ...(attachmentMessage ? { attachment: {
          descriptor: attachmentMessage.attachment,
          download: () => this.downloadAttachment(attachmentMessage.attachment),
          downloadTo: (filePath, options) => this.downloadAttachmentToFile(attachmentMessage.attachment, filePath, options),
        } } : {}),
        sender,
        receivedAt: new Date(frame.envelope.timestamp),
        isSupervisor,
        mentions: directedMessage?.mentions ?? [],
        isMentioned,
        reply: (replyText) => this.sendEnvelope(sender.handle, replyText, frame.envelope.conversation_id),
        replyAttachment: (input) => this.sendAttachmentEnvelope(sender.handle, input, frame.envelope.conversation_id),
        replyAttachmentFile: (input) => this.sendAttachmentFileEnvelope(sender.handle, input, frame.envelope.conversation_id),
        relay: async (relayText) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          return this.sendEnvelope(counterparty.handle, relayText, frame.envelope.conversation_id);
        },
        relayAttachment: async (input) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          return this.sendAttachmentEnvelope(counterparty.handle, input, frame.envelope.conversation_id);
        },
        relayAttachmentFile: async (input) => {
          if (!isSupervisor) throw new Error("Only supervisor messages can be relayed");
          if (!counterparty) throw new Error("No active counterparty exists for this supervised conversation");
          return this.sendAttachmentFileEnvelope(counterparty.handle, input, frame.envelope.conversation_id);
        },
        markRead: async () => {
          if (!handlerComplete) {
            acknowledgedState = "READ";
            return;
          }
          await this.markMessageRead(frame.envelope.message_id);
        },
        routing,
      });
    handlerComplete = true;
    await this.completeIncoming(frame.envelope.message_id, acknowledgedState);
    this.sendFrame({ kind: "ACK", messageId: frame.envelope.message_id, state: acknowledgedState });
    this.scheduleInboxRetry();
  }

  private async sendEnvelope(recipientHandle: string, text: string, conversationId: string): Promise<string> {
    const credentials = this.requireCredentials();
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
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === recipient.id);
    if (!isSupervisor) {
      this.counterparties.set(conversationId, recipient);
      await this.mutateRuntimeState((state) => {
        state.counterparties[conversationId] = recipient;
      });
    }
    await this.queueEnvelope(envelope);
    if (!isSupervisor) {
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
      await this.uploadAttachment({ recipientPeerId: recipient.id }, part.id, part.ciphertext);
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
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === recipient.id);
    if (!isSupervisor) {
      this.counterparties.set(conversationId, recipient);
      await this.mutateRuntimeState((state) => {
        state.counterparties[conversationId] = recipient;
      });
    }
    await this.queueEnvelope(envelope);
    if (!isSupervisor) {
      await this.mirrorActivity("OUTGOING", recipient, plaintext, conversationId, envelope.message_id, envelope.timestamp);
    }
    return envelope.message_id;
  }

  private async sendAttachmentFileEnvelope(
    recipientHandle: string,
    input: AgentAttachmentFileInput,
    conversationId: string,
  ): Promise<string> {
    const credentials = this.requireCredentials();
    const path = resolve(input.path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("ATTACHMENT_NOT_A_FILE");
    const { recipient } = await this.request<{ recipient: PublicPeer }>("/v1/messages/authorize", {
      method: "POST",
      body: JSON.stringify({ recipientHandle }),
    });
    const descriptor = createChunkedAttachmentDescriptor({
      id: randomUUID(),
      size: metadata.size,
      name: input.name?.trim() || basename(path),
      mimeType: input.mimeType?.trim() || mimeTypeFromPath(path),
      nextId: randomUUID,
    });
    if (descriptor.version !== 2) throw new Error("ATTACHMENT_VERSION_UNSUPPORTED");
    const file = await open(path, "r");
    let transferred = 0;
    try {
      for (let index = 0; index < descriptor.chunks.length; index += 1) {
        throwIfAborted(input.transfer?.signal);
        const part = descriptor.chunks[index]!;
        const plaintext = new Uint8Array(part.plaintextSize);
        const { bytesRead } = await file.read(plaintext, 0, plaintext.byteLength, transferred);
        if (bytesRead !== plaintext.byteLength) throw new Error("ATTACHMENT_SIZE_MISMATCH");
        await this.uploadAttachment(
          { recipientPeerId: recipient.id },
          part.id,
          encryptAttachmentChunk(plaintext, descriptor, index),
          input.transfer,
        );
        transferred += bytesRead;
        input.transfer?.onProgress?.({
          phase: "UPLOADING",
          bytesTransferred: transferred,
          totalBytes: descriptor.size,
          partIndex: index + 1,
          partCount: descriptor.chunks.length,
        });
      }
    } catch (error) {
      // Delete every id in the unpublished descriptor. This also removes a part
      // whose POST reached the server but whose response was lost in transit.
      await Promise.allSettled(descriptor.chunks.map((part) => this.deleteAttachmentPart(part.id)));
      throw error;
    } finally {
      await file.close();
    }
    const caption = input.caption?.trim();
    const plaintext = encodeAttachmentMessage({ attachment: descriptor, ...(caption ? { caption } : {}) });
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
    const isSupervisor = this.supervisors.some((supervisor) => supervisor.id === recipient.id);
    if (!isSupervisor) {
      this.counterparties.set(conversationId, recipient);
      await this.mutateRuntimeState((state) => { state.counterparties[conversationId] = recipient; });
    }
    await this.queueEnvelope(envelope);
    if (!isSupervisor) {
      await this.mirrorActivity("OUTGOING", recipient, plaintext, conversationId, envelope.message_id, envelope.timestamp);
    }
    return envelope.message_id;
  }

  private async uploadAttachment(
    scope: { recipientPeerId: string } | { workroomId: string },
    attachmentId: string,
    ciphertext: Uint8Array,
    options?: AttachmentTransferOptions,
  ): Promise<void> {
    throwIfAborted(options?.signal);
    const existing = await this.authorizedFetch(`${this.baseUrl}/v1/attachments/${attachmentId}`, {
      method: "HEAD", ...(options?.signal ? { signal: options.signal } : {}),
    }).catch(() => undefined);
    if (existing?.ok) return;
    const attempts = Math.max(1, Math.min(5, options?.maxAttempts ?? 3));
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(options?.signal);
      let response: Response;
      try {
        response = await this.authorizedFetch(
          `${this.baseUrl}/v1/attachments/${attachmentId}?${"recipientPeerId" in scope
            ? `recipientPeerId=${encodeURIComponent(scope.recipientPeerId)}`
            : `workroomId=${encodeURIComponent(scope.workroomId)}`}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: exactArrayBuffer(ciphertext),
            ...(options?.signal ? { signal: options.signal } : {}),
          },
        );
      } catch (error) {
        if (options?.signal?.aborted) throw abortError();
        lastError = error;
        if (attempt + 1 < attempts) await abortableDelay(250 * (2 ** attempt), options?.signal);
        continue;
      }
      if (response.ok) return;
      lastError = await responseError(response);
      if (response.status < 500 && response.status !== 429) throw lastError;
      if (attempt + 1 < attempts) await abortableDelay(250 * (2 ** attempt), options?.signal);
    }
    throw lastError instanceof Error ? lastError : new Error("ATTACHMENT_UPLOAD_FAILED");
  }

  private async deleteAttachmentPart(id: string): Promise<void> {
    await this.authorizedFetch(`${this.baseUrl}/v1/attachments/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  private async downloadAttachmentToFile(
    descriptor: AttachmentDescriptor,
    filePath: string,
    options?: AttachmentTransferOptions,
  ): Promise<string> {
    const target = resolve(filePath);
    await mkdir(dirname(target), { recursive: true });
    if (descriptor.version === 1) {
      throwIfAborted(options?.signal);
      await writeFile(target, await this.downloadAttachment(descriptor), { mode: 0o600 });
      options?.onProgress?.({ phase: "DOWNLOADING", bytesTransferred: descriptor.size, totalBytes: descriptor.size, partIndex: 1, partCount: 1 });
      return target;
    }
    const chunks = descriptor.chunks;
    const temporary = `${target}.atalk-${randomUUID()}.part`;
    const file = await open(temporary, "wx", 0o600);
    let transferred = 0;
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        throwIfAborted(options?.signal);
        const part = chunks[index]!;
        const ciphertext = await this.downloadAttachmentPart(part.id, options);
        const plaintext = decryptAttachmentChunk(ciphertext, descriptor, index);
        await file.write(plaintext);
        transferred += plaintext.byteLength;
        options?.onProgress?.({
          phase: "DOWNLOADING", bytesTransferred: transferred, totalBytes: descriptor.size,
          partIndex: index + 1, partCount: chunks.length,
        });
      }
      await file.sync();
      await file.close();
      await rename(temporary, target);
      return target;
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async downloadAttachmentPart(id: string, options?: AttachmentTransferOptions): Promise<Uint8Array> {
    const attempts = Math.max(1, Math.min(5, options?.maxAttempts ?? 3));
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(options?.signal);
      let response: Response;
      try {
        response = await this.authorizedFetch(`${this.baseUrl}/v1/attachments/${id}`, {
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options?.signal?.aborted) throw abortError();
        lastError = error;
        if (attempt + 1 < attempts) await abortableDelay(250 * (2 ** attempt), options?.signal);
        continue;
      }
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      lastError = await responseError(response);
      if (response.status < 500 && response.status !== 429) throw lastError;
      if (attempt + 1 < attempts) await abortableDelay(250 * (2 ** attempt), options?.signal);
    }
    throw lastError instanceof Error ? lastError : new Error("ATTACHMENT_DOWNLOAD_FAILED");
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
        messageId: deterministicUuid(`${sourceMessageId}:${supervisor.id}:${direction}:activity`),
        conversationId,
        senderPeerId: credentials.peer.id,
        recipientPeerId: supervisor.id,
        timestamp: new Date().toISOString(),
        plaintext,
        senderSigningSecretKey: credentials.keys.signingSecretKey,
        senderEncryptionSecretKey: credentials.keys.encryptionSecretKey,
        recipientEncryptionPublicKey: supervisor.encryptionPublicKey,
      });
      await this.queueEnvelope(envelope);
    }
  }

  private async queueEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    await this.mutateRuntimeState((state) => {
      if (!state.outbox.some((item) => item.message_id === envelope.message_id)) state.outbox.push(envelope);
    });
    if (this.connected) await this.drainOutbox();
  }

  private async removeFromOutbox(messageId: string): Promise<void> {
    if (!this.runtimeState.outbox.some((item) => item.message_id === messageId)) return;
    await this.mutateRuntimeState((state) => {
      state.outbox = state.outbox.filter((item) => item.message_id !== messageId);
    });
    this.sentThisConnection.delete(messageId);
  }

  private async drainOutbox(): Promise<void> {
    if (this.outboxDrain) return this.outboxDrain;
    const drain = (async () => {
      while (this.connected) {
        const envelope = this.runtimeState.outbox.find((item) => !this.sentThisConnection.has(item.message_id));
        if (!envelope) return;
        this.sendFrame({ kind: "DELIVER", envelope });
        this.sentThisConnection.add(envelope.message_id);
      }
    })();
    this.outboxDrain = drain;
    try {
      await drain;
    } finally {
      if (this.outboxDrain === drain) this.outboxDrain = undefined;
    }
  }

  private async rememberIncoming(envelope: EncryptedEnvelope): Promise<void> {
    if (this.runtimeState.inbox.some((item) => item.message_id === envelope.message_id)) return;
    await this.mutateRuntimeState((runtime) => {
      if (!runtime.inbox.some((item) => item.message_id === envelope.message_id)) runtime.inbox.push(envelope);
    });
  }

  private async completeIncoming(messageId: string, state: "DELIVERED" | "READ"): Promise<void> {
    await this.mutateRuntimeState((runtime) => {
      runtime.processedIncoming[messageId] = runtime.processedIncoming[messageId] === "READ" ? "READ" : state;
      const ids = Object.keys(runtime.processedIncoming);
      for (let index = 0; index < ids.length - MAX_PROCESSED_INCOMING; index += 1) {
        delete runtime.processedIncoming[ids[index]!];
      }
    });
  }

  private async forgetIncoming(messageId: string): Promise<void> {
    if (!this.runtimeState.inbox.some((item) => item.message_id === messageId)) return;
    await this.mutateRuntimeState((runtime) => {
      runtime.inbox = runtime.inbox.filter((item) => item.message_id !== messageId);
    });
    if (this.runtimeState.inbox.length === 0 && this.inboxRetryTimer) {
      clearTimeout(this.inboxRetryTimer);
      this.inboxRetryTimer = undefined;
      this.inboxRetryAttempt = 0;
    }
  }

  private async drainInbox(): Promise<void> {
    if (this.inboxDrain) return this.inboxDrain;
    const drain = (async () => {
      if (!this.connected) {
        this.scheduleInboxRetry();
        return;
      }
      for (const envelope of [...this.runtimeState.inbox]) {
        try {
          await this.handleFrame({ kind: "MESSAGE", envelope });
        } catch (error) {
          this.emitError(error);
          this.scheduleInboxRetry();
          return;
        }
      }
      if (this.runtimeState.inbox.length === 0) this.inboxRetryAttempt = 0;
    })();
    this.inboxDrain = drain;
    try {
      await drain;
    } finally {
      if (this.inboxDrain === drain) this.inboxDrain = undefined;
    }
  }

  private scheduleInboxRetry(): void {
    if (this.stopped || this.runtimeState.inbox.length === 0 || this.inboxRetryTimer) return;
    const delay = reconnectDelay(this.inboxRetryAttempt++);
    this.inboxRetryTimer = setTimeout(() => {
      this.inboxRetryTimer = undefined;
      void this.drainInbox();
    }, delay);
  }

  private async mutateRuntimeState(mutator: (state: AgentRuntimeState) => void): Promise<void> {
    const operation = this.stateMutation.then(async () => {
      const next = structuredClone(this.runtimeState);
      mutator(next);
      await this.runtimeStateStore.save(next);
      this.runtimeState = next;
    });
    this.stateMutation = operation.catch(() => undefined);
    return operation;
  }

  private sendFrame(frame: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Agent is not connected");
    this.socket.send(JSON.stringify(frame));
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = { "content-type": "application/json", ...init.headers };
    const response = authenticated
      ? await this.authorizedFetch(`${this.baseUrl}${path}`, { ...init, headers })
      : await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await response.json() as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new AgentProtocolError(
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.message ?? `HTTP ${response.status}`,
    );
    return body;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    await this.refreshCredentialsIfNeeded("EXPIRING");
    const response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken(this.requireCredentials())}`,
        ...init.headers,
      },
    });
    if (response.status === 401 && retry && await this.refreshCredentialsIfNeeded("UNAUTHORIZED", true)) {
      return this.authorizedFetch(url, init, false);
    }
    return response;
  }

  private async refreshCredentialsIfNeeded(
    reason: "EXPIRING" | "UNAUTHORIZED",
    force = false,
  ): Promise<boolean> {
    if (!this.credentialRefresher || !this.credentials) return false;
    if (reason === "EXPIRING" && !force) {
      const expiresAt = this.credentials.accessTokenExpiresAt
        ? Date.parse(this.credentials.accessTokenExpiresAt)
        : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + this.refreshLeewayMs) return false;
    }
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = (async () => {
      let current = this.requireCredentials();
      if (this.usesDefaultCredentialRefresher && current.refreshToken && !current.refreshRequestId) {
        current = { ...current, refreshRequestId: randomUUID() };
        // Persist intent before sending. If the successful response is lost, a
        // restart repeats the same server-side operation instead of reusing the
        // rotated token under a new idempotency key.
        await this.credentialStore.save(current);
        this.credentials = current;
      }
      let refreshed: Awaited<ReturnType<CredentialRefresher>>;
      try {
        refreshed = await this.credentialRefresher!({ credentials: current, reason, baseUrl: this.baseUrl });
      } catch (error) {
        if (this.usesDefaultCredentialRefresher && current.refreshRequestId && isSessionError(error)) {
          const { refreshRequestId: _failedRefreshRequest, ...restored } = current;
          await this.credentialStore.save(restored);
          this.credentials = restored;
        }
        throw error;
      }
      if (!refreshed) return false;
      const {
        accessTokenExpiresAt: _previousExpiry,
        refreshRequestId: _completedRefreshRequest,
        ...currentWithoutExpiry
      } = current;
      const next: AgentCredentials = {
        ...currentWithoutExpiry,
        sessionToken: refreshed.accessToken,
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken ?? current.refreshToken
          ? { refreshToken: refreshed.refreshToken ?? current.refreshToken }
          : {}),
        ...(refreshed.accessTokenExpiresAt ? { accessTokenExpiresAt: refreshed.accessTokenExpiresAt } : {}),
      };
      await this.credentialStore.save(next);
      this.credentials = next;
      return true;
    })();
    this.refreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = undefined;
    }
  }

  private async connectWithRefresh(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      if (isSessionError(error) && await this.refreshCredentialsIfNeeded("UNAUTHORIZED", true)) {
        await this.connect();
        return;
      }
      throw error;
    }
  }

  private async recoverRejectedSession(): Promise<void> {
    try {
      if (!await this.refreshCredentialsIfNeeded("UNAUTHORIZED", true)) {
        this.stopped = true;
        this.emitError(new AgentProtocolError("INVALID_SESSION", "Agent credentials were rejected"));
        return;
      }
      if (!this.stopped) await this.connectWithRefresh();
    } catch (error) {
      if (isSessionError(error)) this.stopped = true;
      this.emitError(error);
      if (!this.stopped) this.scheduleReconnect();
    }
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

function abortError(): Error {
  const error = new Error("Attachment transfer was cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      rejectDelay(abortError());
    }, { once: true });
  });
}

class AgentProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function accessToken(credentials: AgentCredentials): string {
  return credentials.accessToken ?? credentials.sessionToken;
}

async function refreshAtalkCredentials(
  context: Parameters<CredentialRefresher>[0],
): ReturnType<CredentialRefresher> {
  const refreshToken = context.credentials.refreshToken;
  if (!refreshToken) return undefined;
  const response = await fetch(`${context.baseUrl}/v1/agent-runtime/session/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refreshToken,
      // Deterministic per credential, so a process restart retries the same
      // idempotency operation if the first response was lost.
      requestId: context.credentials.refreshRequestId
        ?? deterministicUuid(`atalk-agent-refresh:${refreshToken}`),
    }),
  });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as {
    token?: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    expiresAt?: string;
  };
  const nextAccessToken = body.accessToken ?? body.token;
  if (!nextAccessToken) throw new Error("INVALID_REFRESH_RESPONSE: aTalk did not return an access token");
  return {
    accessToken: nextAccessToken,
    ...(body.refreshToken ? { refreshToken: body.refreshToken } : {}),
    ...(body.accessTokenExpiresAt ?? body.expiresAt
      ? { accessTokenExpiresAt: body.accessTokenExpiresAt ?? body.expiresAt }
      : {}),
  };
}

function isSessionError(error: unknown): boolean {
  return error instanceof AgentProtocolError && FATAL_SESSION_CODES.has(error.code);
}

function sameIdentityKeys(
  left: AgentCredentials["keys"],
  right: AgentCredentials["keys"],
): boolean {
  return left.signingPublicKey === right.signingPublicKey
    && left.signingSecretKey === right.signingSecretKey
    && left.encryptionPublicKey === right.encryptionPublicKey
    && left.encryptionSecretKey === right.encryptionSecretKey;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
    if (body.error) return new AgentProtocolError(
      body.error.code ?? `HTTP_${response.status}`,
      body.error.message ?? "request failed",
    );
  } catch {
    // Keep the HTTP fallback for non-JSON proxy responses.
  }
  return new AgentProtocolError(`HTTP_${response.status}`, `HTTP ${response.status}`);
}

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6)));
  return exponential + Math.floor(Math.random() * Math.max(1, Math.floor(exponential * 0.2)));
}

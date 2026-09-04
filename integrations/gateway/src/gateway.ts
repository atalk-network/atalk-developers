import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Agent, type IncomingMessage, type SentMessage } from "@atalk/sdk";
import { GATEWAY_SPEC, MAX_ATTACHMENT_BYTES } from "./constants.js";
import {
  FileGatewayInboxStore,
  GatewayInbox,
  MemoryGatewayInboxStore,
  serializeGatewayMessage,
  type GatewayInboxRecord,
  type GatewayInboxStore,
  type GatewayMessageEvent,
} from "./inbox.js";
import { gatewayOpenApiDocument } from "./openapi.js";

export { GATEWAY_SPEC, MAX_ATTACHMENT_BYTES } from "./constants.js";
const MAX_JSON_BYTES = 1 * 1024 * 1024;

export interface GatewayLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface AtalkGatewayOptions {
  token?: string;
  baseUrl?: string;
  credentialPath?: string;
  host?: string;
  port?: number;
  apiKey?: string;
  allowOrigin?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookRetries?: number;
  inboxCapacity?: number;
  inboxPath?: string;
  inboxStore?: GatewayInboxStore;
  agent?: Agent;
  logger?: GatewayLogger;
  fetch?: typeof fetch;
}

export interface AtalkGatewayRuntime {
  readonly agent: Agent;
  readonly inbox: GatewayInbox;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface JsonBody {
  [key: string]: unknown;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function positiveInteger(value: number, fallback: number, maximum: number): number {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requestToken(request: HttpRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const header = request.headers["x-atalk-gateway-key"];
  return Array.isArray(header) ? header[0] : header;
}

function setCors(response: ServerResponse, allowOrigin: string | undefined): void {
  if (!allowOrigin) return;
  response.setHeader("access-control-allow-origin", allowOrigin);
  response.setHeader("access-control-allow-headers", "authorization, content-type, x-atalk-caption, x-atalk-filename, x-atalk-gateway-key");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("vary", "origin");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function sendMandatedResult(response: ServerResponse, operationId: string, result: unknown): void {
  const status = result && typeof result === "object" && "status" in result
    ? (result as { status?: unknown }).status
    : undefined;
  sendJson(response, status === "executed" ? 201 : status === "requires_approval" ? 202 : 403, {
    operationId,
    result,
  });
}

async function readBody(request: HttpRequest, maximum: number): Promise<Buffer> {
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Body cannot exceed ${maximum} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.byteLength;
    if (size > maximum) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Body cannot exceed ${maximum} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function stageRequestBody(request: HttpRequest, maximum: number): Promise<{
  path: string;
  size: number;
  cleanup(): Promise<void>;
}> {
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Body cannot exceed ${maximum} bytes`);
  const directory = await mkdtemp(join(tmpdir(), "atalk-gateway-"));
  const path = join(directory, "attachment.bin");
  const file = await open(path, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += value.byteLength;
      if (size > maximum) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Body cannot exceed ${maximum} bytes`);
      await file.write(value);
    }
    await file.sync();
    return { path, size, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
}

async function stageDownload(name: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "atalk-gateway-download-"));
  return {
    path: join(directory, safeFileName(name)),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function readJson(request: HttpRequest): Promise<JsonBody> {
  const bytes = await readBody(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as JsonBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

function requiredString(body: JsonBody, name: string, maximum: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HttpError(400, "INVALID_REQUEST", `${name} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function optionalString(body: JsonBody, name: string, maximum: number): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new HttpError(400, "INVALID_REQUEST", `${name} must be a string of at most ${maximum} characters`);
  }
  return value;
}

function headerString(request: HttpRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeFileName(value: string): string {
  return value.replace(/[\r\n"\\/]+/gu, "_").slice(0, 180) || "attachment";
}

type MessageContext = { live: IncomingMessage; record?: never } | { live?: never; record: GatewayInboxRecord };

function messageOrThrow(inbox: GatewayInbox, id: string): MessageContext {
  const live = inbox.get(id);
  if (live) return { live };
  const record = inbox.getRecord(id);
  if (record) return { record };
  throw new HttpError(404, "MESSAGE_NOT_FOUND", "The message is unknown or has been acknowledged");
}

function replyText(message: IncomingMessage, text: string): Promise<string> {
  return message.isSupervisor && !message.isMentioned ? message.relay(text) : message.reply(text);
}

function replyAttachment(message: IncomingMessage, data: Uint8Array, name: string, mimeType: string, caption?: string): Promise<string> {
  const input = { data, name, mimeType, ...(caption ? { caption } : {}) };
  return message.isSupervisor && !message.isMentioned ? message.relayAttachment(input) : message.replyAttachment(input);
}

function durableTarget(record: GatewayInboxRecord): string {
  if (record.routing.targetHandle) return record.routing.targetHandle;
  throw new HttpError(409, "ROUTING_CONTEXT_MISSING", "This persisted supervisor event has no known counterparty");
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

class GatewayRuntime implements AtalkGatewayRuntime {
  readonly agent: Agent;
  readonly inbox: GatewayInbox;
  readonly host: string;
  private readonly configuredPort: number;
  private readonly apiKey: string | undefined;
  private readonly allowOrigin: string | undefined;
  private readonly webhookUrl: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly webhookRetries: number;
  private readonly logger: GatewayLogger;
  private readonly fetcher: typeof fetch;
  private readonly server: Server;
  private started = false;

  constructor(options: AtalkGatewayOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.configuredPort = options.port ?? 8788;
    this.apiKey = options.apiKey;
    this.allowOrigin = options.allowOrigin;
    this.webhookUrl = options.webhookUrl;
    this.webhookSecret = options.webhookSecret;
    this.webhookRetries = Math.max(1, positiveInteger(options.webhookRetries ?? 3, 3, 10));
    this.logger = options.logger ?? console;
    this.fetcher = options.fetch ?? fetch;
    if (!isLoopback(this.host) && !this.apiKey) {
      throw new Error("ATALK_GATEWAY_API_KEY is required when the gateway listens outside localhost");
    }
    if (!Number.isInteger(this.configuredPort) || this.configuredPort < 0 || this.configuredPort > 65_535) {
      throw new Error("Gateway port must be an integer between 0 and 65535");
    }
    this.agent = options.agent ?? new Agent({
      ...(options.token ? { token: options.token } : {}),
      baseUrl: options.baseUrl ?? "https://api.atalk.ar",
      ...(options.credentialPath ? { credentialPath: options.credentialPath } : {}),
    });
    const inboxStore = options.inboxStore
      ?? (options.inboxPath
        ? new FileGatewayInboxStore(options.inboxPath)
        : options.credentialPath
          ? new FileGatewayInboxStore(`${options.credentialPath}.inbox.json`)
          : options.agent
            ? new MemoryGatewayInboxStore()
            : new FileGatewayInboxStore(resolve(".atalk/gateway-inbox.json")));
    const inboxCapacity = Math.max(1, positiveInteger(options.inboxCapacity ?? 500, 500, 100_000));
    this.inbox = new GatewayInbox(inboxCapacity, inboxStore);
    this.agent.on("message", async (message) => {
      await this.inbox.push(message);
      if (this.webhookUrl) {
        void this.deliverWebhook(message).catch((error: unknown) => {
          this.logger.error(`[aTalk Gateway] Webhook failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    });
    this.agent.on("error", (error) => this.logger.error(`[aTalk Gateway] ${error.message}`));
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        if (error instanceof HttpError) sendError(response, error.status, error.code, error.message);
        else {
          this.logger.error(`[aTalk Gateway] HTTP error: ${error instanceof Error ? error.message : String(error)}`);
          sendError(response, 500, "INTERNAL_ERROR", "The gateway could not complete the request");
        }
      });
    });
  }

  get port(): number {
    const address = this.server.address();
    return address && typeof address !== "string" ? (address as AddressInfo).port : this.configuredPort;
  }

  get url(): string {
    const printableHost = this.host === "::1" ? "[::1]" : this.host;
    return `http://${printableHost}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.inbox.initialize();
    await this.agent.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.server.once("error", onError);
        this.server.listen(this.configuredPort, this.host, () => {
          this.server.off("error", onError);
          resolve();
        });
      });
      this.started = true;
    } catch (error) {
      await this.agent.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
    await this.agent.stop();
    this.started = false;
  }

  private authorized(request: HttpRequest): boolean {
    return !this.apiKey || Boolean(requestToken(request) && constantTimeEqual(requestToken(request)!, this.apiKey));
  }

  private async route(request: HttpRequest, response: ServerResponse): Promise<void> {
    setCors(response, this.allowOrigin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", this.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const canInspect = this.authorized(request);
      sendJson(response, 200, {
        status: "ok",
        spec: GATEWAY_SPEC,
        ...(canInspect ? { connected: this.agent.connected } : {}),
        identity: canInspect && this.agent.peer ? {
          id: this.agent.peer.id,
          handle: this.agent.peer.handle,
          displayName: this.agent.peer.displayName,
          type: this.agent.peer.type,
        } : null,
        queuedEvents: this.inbox.pending,
      });
      return;
    }
    if (!this.authorized(request)) {
      sendError(response, 401, "UNAUTHORIZED", "Provide the gateway API key as a Bearer token or X-aTalk-Gateway-Key header");
      return;
    }
    if (request.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
      sendJson(response, 200, gatewayOpenApiDocument(this.url));
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/v1/capabilities" || url.pathname === "/.well-known/atalk-agent-gateway")) {
      sendJson(response, 200, {
        spec: GATEWAY_SPEC,
        delivery: ["long-polling", "durable-explicit-ack", ...(this.webhookUrl ? ["webhook"] : [])],
        capabilities: [
          "text", "image", "video", "audio", "file", "read-receipts", "supervision", "directed-mentions",
          "workrooms", "workroom-mentions", "workroom-plan-assignments", "mandate-guard",
          "workroom-mandated-publication", "workroom-attachments",
        ],
        limits: { attachmentBytes: MAX_ATTACHMENT_BYTES, textCharacters: 32_000 },
        endpoints: {
          health: "/health",
          capabilities: "/v1/capabilities",
          openapi: "/openapi.json",
          events: "/v1/events",
          eventAck: "/v1/messages/{messageId}/ack",
          send: "/v1/send",
          sendAttachment: "/v1/send/attachment",
          workrooms: "/v1/workrooms",
          executeWorkroomEvent: "/v1/workrooms/{workroomId}/execute",
          submitWorkroomFile: "/v1/workrooms/{workroomId}/attachments/submit",
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const limit = positiveInteger(Number.parseInt(url.searchParams.get("limit") ?? "10", 10), 10, 100) || 10;
      const waitSeconds = positiveInteger(Number.parseInt(url.searchParams.get("waitSeconds") ?? "0", 10), 0, 30);
      const explicit = url.searchParams.get("mode") === "explicit";
      const records = explicit
        ? await this.inbox.peek(limit, waitSeconds)
        : await this.inbox.take(limit, waitSeconds);
      sendJson(response, 200, { events: records.map((record) => record.event), pendingEvents: this.inbox.pending });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/send") {
      const body = await readJson(request);
      const to = requiredString(body, "to", 100);
      const text = requiredString(body, "text", 32_000);
      const conversationId = optionalString(body, "conversationId", 100);
      const sent: SentMessage = conversationId
        ? { conversationId, messageId: await this.agent.sendInConversation(to, text, conversationId) }
        : await this.agent.sendWithDetails(to, text);
      sendJson(response, 201, sent);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/send/attachment") {
      const to = url.searchParams.get("to")?.trim();
      if (!to || to.length > 100) throw new HttpError(400, "INVALID_REQUEST", "The to query parameter is required");
      const staged = await stageRequestBody(request, MAX_ATTACHMENT_BYTES);
      if (staged.size === 0) {
        await staged.cleanup();
        throw new HttpError(400, "INVALID_REQUEST", "Attachment body cannot be empty");
      }
      const name = safeFileName(url.searchParams.get("name") ?? headerString(request, "x-atalk-filename") ?? "attachment");
      const mimeType = request.headers["content-type"] ?? "application/octet-stream";
      const caption = url.searchParams.get("caption") ?? headerString(request, "x-atalk-caption");
      const conversationId = url.searchParams.get("conversationId") ?? undefined;
      const transfer = new AbortController();
      const abortTransfer = () => transfer.abort();
      request.once("aborted", abortTransfer);
      response.once("close", abortTransfer);
      try {
        const input = { path: staged.path, name, mimeType, ...(caption ? { caption } : {}), transfer: { signal: transfer.signal } };
        const sent: SentMessage = conversationId
          ? { conversationId, messageId: await this.agent.sendAttachmentFileInConversation(to, input, conversationId) }
          : await this.agent.sendAttachmentFileWithDetails(to, input);
        sendJson(response, 201, sent);
      } finally {
        request.off("aborted", abortTransfer);
        response.off("close", abortTransfer);
        await staged.cleanup();
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/workrooms") {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = positiveInteger(Number.parseInt(url.searchParams.get("limit") ?? "50", 10), 50, 200) || 50;
      sendJson(response, 200, await this.agent.workrooms.list(cursor, limit));
      return;
    }

    const workroomMatch = /^\/v1\/workrooms\/([^/]+)(|\/events|\/execute|\/mandates\/guard|\/attachments|\/attachments\/submit|\/attachments\/download|\/attachments\/read)$/u.exec(url.pathname);
    if (workroomMatch) {
      const workroomId = decodeURIComponent(workroomMatch[1]!);
      const action = workroomMatch[2]!;
      if (request.method === "GET" && action === "") {
        sendJson(response, 200, await this.agent.workrooms.get(workroomId));
        return;
      }
      if (request.method === "GET" && action === "/events") {
        const scope = url.searchParams.get("scope") ?? "directed";
        const limit = positiveInteger(Number.parseInt(url.searchParams.get("limit") ?? "100", 10), 100, 500) || 100;
        if (scope === "audit") {
          const afterSequence = positiveInteger(
            Number.parseInt(url.searchParams.get("afterSequence") ?? "0", 10),
            0,
            Number.MAX_SAFE_INTEGER,
          );
          sendJson(response, 200, await this.agent.workrooms.readAuditEvents(workroomId, afterSequence, limit));
          return;
        }
        if (scope !== "directed") {
          throw new HttpError(400, "INVALID_REQUEST", "scope must be directed or audit");
        }
        const events: unknown[] = [];
        const cursor = await this.agent.workrooms.poll(workroomId, (event) => {
          // Defense in depth for injected/custom SDK clients: an agent-facing
          // gateway never turns shared room chatter into a model event.
          if (event.directedToMe) events.push(event);
        }, { limit });
        sendJson(response, 200, { events, cursor, scope: "directed" });
        return;
      }
      if (request.method === "POST" && action === "/events") {
        const body = await readJson(request);
        const threadId = requiredString(body, "threadId", 100);
        if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
          throw new HttpError(400, "INVALID_REQUEST", "payload must be a workroom event object");
        }
        const record = await this.agent.workrooms.publish(workroomId, threadId, body.payload as never, {
          ...(typeof body.eventId === "string" ? { eventId: body.eventId } : {}),
          ...(typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
          ...(body.projection && typeof body.projection === "object" && !Array.isArray(body.projection)
            ? { projection: body.projection as never }
            : {}),
        });
        sendJson(response, 201, record);
        return;
      }
      if (request.method === "POST" && action === "/execute") {
        const body = await readJson(request);
        const threadId = requiredString(body, "threadId", 100);
        const operationId = requiredString(body, "operationId", 100);
        if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
          throw new HttpError(400, "INVALID_REQUEST", "payload must be a workroom event object");
        }
        const mandateId = optionalString(body, "mandateId", 100);
        const rationale = optionalString(body, "rationale", 4_000);
        const result = await this.agent.workrooms.publishMandated({
          workroomId, threadId, operationId, payload: body.payload as never,
          ...(mandateId ? { mandateId } : {}),
          ...(rationale ? { rationale } : {}),
        });
        sendMandatedResult(response, operationId, result);
        return;
      }
      if (request.method === "POST" && action === "/mandates/guard") {
        const body = await readJson(request);
        sendJson(response, 200, await this.agent.workrooms.guardMandateUse({ ...body, workroomId } as never));
        return;
      }
      if (request.method === "POST" && action === "/attachments") {
        const staged = await stageRequestBody(request, MAX_ATTACHMENT_BYTES);
        if (staged.size === 0) {
          await staged.cleanup();
          throw new HttpError(400, "INVALID_REQUEST", "Attachment body cannot be empty");
        }
        const transfer = new AbortController();
        const abortTransfer = () => transfer.abort();
        request.once("aborted", abortTransfer);
        response.once("close", abortTransfer);
        try {
          const descriptor = await this.agent.workrooms.uploadAttachmentFile({
            workroomId,
            path: staged.path,
            name: safeFileName(url.searchParams.get("name") ?? headerString(request, "x-atalk-filename") ?? "attachment"),
            mimeType: request.headers["content-type"] ?? "application/octet-stream",
            transfer: { signal: transfer.signal },
          });
          sendJson(response, 201, { descriptor });
        } finally {
          request.off("aborted", abortTransfer);
          response.off("close", abortTransfer);
          await staged.cleanup();
        }
        return;
      }
      if (request.method === "POST" && action === "/attachments/submit") {
        const threadId = url.searchParams.get("threadId")?.trim();
        const operationId = url.searchParams.get("operationId")?.trim();
        if (!threadId || threadId.length > 100) throw new HttpError(400, "INVALID_REQUEST", "The threadId query parameter is required");
        if (!operationId || operationId.length > 100) throw new HttpError(400, "INVALID_REQUEST", "The operationId query parameter is required");
        const staged = await stageRequestBody(request, MAX_ATTACHMENT_BYTES);
        if (staged.size === 0) {
          await staged.cleanup();
          throw new HttpError(400, "INVALID_REQUEST", "Attachment body cannot be empty");
        }
        let mentions: unknown[] = [];
        const encodedMentions = url.searchParams.get("mentions");
        if (encodedMentions) {
          try {
            const parsed = JSON.parse(encodedMentions) as unknown;
            if (!Array.isArray(parsed)) throw new Error("not an array");
            mentions = parsed;
          } catch {
            await staged.cleanup();
            throw new HttpError(400, "INVALID_REQUEST", "mentions must be a JSON array");
          }
        }
        const transfer = new AbortController();
        const abortTransfer = () => transfer.abort();
        request.once("aborted", abortTransfer);
        response.once("close", abortTransfer);
        try {
          const result = await this.agent.workrooms.submitFileMandated({
            workroomId, threadId, operationId, path: staged.path,
            name: safeFileName(url.searchParams.get("name") ?? headerString(request, "x-atalk-filename") ?? "attachment"),
            mimeType: request.headers["content-type"] ?? "application/octet-stream",
            mentions: mentions as never,
            ...(url.searchParams.get("mandateId") ? { mandateId: url.searchParams.get("mandateId")! } : {}),
            ...(url.searchParams.get("title") ? { title: url.searchParams.get("title")! } : {}),
            ...(url.searchParams.get("description") ? { description: url.searchParams.get("description")! } : {}),
            ...(url.searchParams.get("artifactType") ? { artifactType: url.searchParams.get("artifactType")! } : {}),
            ...(url.searchParams.get("artifactId") ? { artifactId: url.searchParams.get("artifactId")! } : {}),
            ...(url.searchParams.get("artifactVersion") ? { artifactVersion: Number.parseInt(url.searchParams.get("artifactVersion")!, 10) } : {}),
            transfer: { signal: transfer.signal },
          });
          sendMandatedResult(response, operationId, result);
        } finally {
          request.off("aborted", abortTransfer);
          response.off("close", abortTransfer);
          await staged.cleanup();
        }
        return;
      }
      if (request.method === "POST" && action === "/attachments/download") {
        const body = await readJson(request);
        if (!body.descriptor || typeof body.descriptor !== "object" || Array.isArray(body.descriptor)) {
          throw new HttpError(400, "INVALID_REQUEST", "descriptor must be an encrypted attachment descriptor");
        }
        const descriptor = body.descriptor as { id?: unknown; name?: unknown; mimeType?: unknown; size?: unknown };
        if (typeof descriptor.id !== "string" || typeof descriptor.name !== "string"
          || typeof descriptor.mimeType !== "string" || typeof descriptor.size !== "number") {
          throw new HttpError(400, "INVALID_REQUEST", "descriptor fields are invalid");
        }
        const staged = await stageDownload(descriptor.name);
        const transfer = new AbortController();
        const abortTransfer = () => transfer.abort();
        request.once("aborted", abortTransfer);
        response.once("close", abortTransfer);
        try {
          await this.agent.workrooms.downloadAttachmentTo(body.descriptor as never, staged.path, { signal: transfer.signal });
        } catch (error) {
          await staged.cleanup();
          throw error;
        } finally {
          request.off("aborted", abortTransfer);
          response.off("close", abortTransfer);
        }
        response.writeHead(200, {
          "content-type": descriptor.mimeType,
          "content-length": descriptor.size,
          "content-disposition": `attachment; filename="${safeFileName(descriptor.name)}"`,
          "cache-control": "no-store",
        });
        const source = createReadStream(staged.path);
        const cleanup = () => { void staged.cleanup(); };
        source.once("error", (error) => { cleanup(); response.destroy(error); });
        response.once("close", cleanup);
        source.pipe(response);
        return;
      }
      if (request.method === "POST" && action === "/attachments/read") {
        const body = await readJson(request);
        const threadId = requiredString(body, "threadId", 100);
        const operationId = requiredString(body, "operationId", 100);
        if (!body.descriptor || typeof body.descriptor !== "object" || Array.isArray(body.descriptor)) {
          throw new HttpError(400, "INVALID_REQUEST", "descriptor must be an encrypted attachment descriptor");
        }
        const descriptor = body.descriptor as { id?: unknown; name?: unknown; mimeType?: unknown; size?: unknown };
        if (typeof descriptor.id !== "string" || typeof descriptor.name !== "string"
          || typeof descriptor.mimeType !== "string" || typeof descriptor.size !== "number") {
          throw new HttpError(400, "INVALID_REQUEST", "descriptor fields are invalid");
        }
        const staged = await stageDownload(descriptor.name);
        const transfer = new AbortController();
        const abortTransfer = () => transfer.abort();
        request.once("aborted", abortTransfer);
        response.once("close", abortTransfer);
        const mandateId = optionalString(body, "mandateId", 100);
        const rationale = optionalString(body, "rationale", 4_000);
        try {
          const result = await this.agent.workrooms.downloadAttachmentToMandated({
            workroomId, threadId, operationId, descriptor: body.descriptor as never, path: staged.path,
            ...(mandateId ? { mandateId } : {}), ...(rationale ? { rationale } : {}),
            transfer: { signal: transfer.signal },
          });
          if (result.status !== "executed") {
            await staged.cleanup();
            sendMandatedResult(response, operationId, result);
            return;
          }
        } catch (error) {
          await staged.cleanup();
          throw error;
        } finally {
          request.off("aborted", abortTransfer);
          response.off("close", abortTransfer);
        }
        response.writeHead(200, {
          "content-type": descriptor.mimeType,
          "content-length": descriptor.size,
          "content-disposition": `attachment; filename="${safeFileName(descriptor.name)}"`,
          "cache-control": "no-store",
          "x-atalk-operation-id": operationId,
        });
        const source = createReadStream(staged.path);
        const cleanup = () => { void staged.cleanup(); };
        source.once("error", (error) => { cleanup(); response.destroy(error); });
        response.once("close", cleanup);
        source.pipe(response);
        return;
      }
    }

    const match = /^\/v1\/messages\/([^/]+)(\/attachment|\/reply|\/reply\/attachment|\/read|\/ack)$/u.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      if (request.method === "POST" && action === "/ack") {
        if (!await this.inbox.ack(id)) throw new HttpError(404, "MESSAGE_NOT_FOUND", "The event is not pending");
        sendJson(response, 200, { messageId: id, acknowledged: true });
        return;
      }
      const message = messageOrThrow(this.inbox, id);
      if (request.method === "GET" && action === "/attachment") {
        const descriptor = message.live?.attachment?.descriptor ?? message.record?.attachmentDescriptor;
        if (!descriptor) throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "The selected message has no attachment");
        const staged = await stageDownload(descriptor.name);
        const transfer = new AbortController();
        const abortTransfer = () => transfer.abort();
        request.once("aborted", abortTransfer);
        response.once("close", abortTransfer);
        try {
          await (message.live?.attachment
            ? message.live.attachment.downloadTo(staged.path, { signal: transfer.signal })
            : this.agent.downloadAttachmentTo(descriptor, staged.path, { signal: transfer.signal }));
        } catch (error) {
          await staged.cleanup();
          throw error;
        } finally {
          request.off("aborted", abortTransfer);
          response.off("close", abortTransfer);
        }
        response.writeHead(200, {
          "content-type": descriptor.mimeType,
          "content-length": descriptor.size,
          "content-disposition": `attachment; filename="${safeFileName(descriptor.name)}"`,
          "cache-control": "no-store",
        });
        const source = createReadStream(staged.path);
        const cleanup = () => { void staged.cleanup(); };
        source.once("error", (error) => { cleanup(); response.destroy(error); });
        response.once("close", cleanup);
        source.pipe(response);
        return;
      }
      if (request.method === "POST" && action === "/read") {
        if (message.live) await message.live.markRead();
        else await this.agent.markMessageRead(id);
        sendJson(response, 200, { messageId: id, state: "READ" });
        return;
      }
      if (request.method === "POST" && action === "/reply") {
        const body = await readJson(request);
        const text = requiredString(body, "text", 32_000);
        const record = message.record;
        const conversationId = message.live?.conversationId ?? record!.event.data.conversationId;
        const messageId = message.live
          ? await replyText(message.live, text)
          : await this.agent.sendInConversation(durableTarget(record!), text, conversationId);
        sendJson(response, 201, { messageId, conversationId });
        return;
      }
      if (request.method === "POST" && action === "/reply/attachment") {
        const staged = await stageRequestBody(request, MAX_ATTACHMENT_BYTES);
        if (staged.size === 0) {
          await staged.cleanup();
          throw new HttpError(400, "INVALID_REQUEST", "Attachment body cannot be empty");
        }
        const name = safeFileName(url.searchParams.get("name") ?? headerString(request, "x-atalk-filename") ?? "attachment");
        const mimeType = request.headers["content-type"] ?? "application/octet-stream";
        const caption = url.searchParams.get("caption") ?? headerString(request, "x-atalk-caption");
        const record = message.record;
        const conversationId = message.live?.conversationId ?? record!.event.data.conversationId;
        const transfer = new AbortController();
        const abortTransfer = () => transfer.abort();
        request.once("aborted", abortTransfer);
        response.once("close", abortTransfer);
        try {
          const input = { path: staged.path, name, mimeType, ...(caption ? { caption } : {}), transfer: { signal: transfer.signal } };
          const messageId = message.live
            ? await (message.live.isSupervisor && !message.live.isMentioned
              ? message.live.relayAttachmentFile(input)
              : message.live.replyAttachmentFile(input))
            : await this.agent.sendAttachmentFileInConversation(durableTarget(record!), input, conversationId);
          sendJson(response, 201, { messageId, conversationId });
        } finally {
          request.off("aborted", abortTransfer);
          response.off("close", abortTransfer);
          await staged.cleanup();
        }
        return;
      }
    }
    sendError(response, 404, "NOT_FOUND", "Gateway endpoint not found");
  }

  private async deliverWebhook(message: IncomingMessage): Promise<void> {
    const event = serializeGatewayMessage(message);
    const body = JSON.stringify(event);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.webhookRetries; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "aTalk-Gateway/1",
          "x-atalk-event-id": event.id,
          "x-atalk-spec": GATEWAY_SPEC,
        };
        if (this.webhookSecret) headers["x-atalk-signature"] = `sha256=${createHmac("sha256", this.webhookSecret).update(body).digest("hex")}`;
        const response = await this.fetcher(this.webhookUrl!, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await this.applyWebhookResponse(message, response);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt + 1 < this.webhookRetries) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
      }
    }
    throw lastError ?? new Error("Webhook delivery failed");
  }

  private async applyWebhookResponse(message: IncomingMessage, response: Response): Promise<void> {
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) return;
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const value = body as { markRead?: unknown; text?: unknown; reply?: { text?: unknown } };
    if (value.markRead === true) await message.markRead();
    const text = typeof value.reply?.text === "string" ? value.reply.text : typeof value.text === "string" ? value.text : undefined;
    if (text?.trim()) await replyText(message, text.slice(0, 32_000));
  }
}

export function createAtalkGateway(options: AtalkGatewayOptions = {}): AtalkGatewayRuntime {
  return new GatewayRuntime(options);
}

export type { GatewayMessageEvent };

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage as HttpRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, type IncomingMessage, type SentMessage } from "@atalk/sdk";
import { GATEWAY_SPEC, MAX_ATTACHMENT_BYTES } from "./constants.js";
import { GatewayInbox, serializeGatewayMessage, type GatewayMessageEvent } from "./inbox.js";
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

function messageOrThrow(inbox: GatewayInbox, id: string): IncomingMessage {
  const message = inbox.get(id);
  if (!message) throw new HttpError(404, "MESSAGE_NOT_FOUND", "The message is unknown or has expired from the gateway cache");
  return message;
}

function replyText(message: IncomingMessage, text: string): Promise<string> {
  return message.isSupervisor ? message.relay(text) : message.reply(text);
}

function replyAttachment(message: IncomingMessage, data: Uint8Array, name: string, mimeType: string, caption?: string): Promise<string> {
  const input = { data, name, mimeType, ...(caption ? { caption } : {}) };
  return message.isSupervisor ? message.relayAttachment(input) : message.replyAttachment(input);
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
    this.inbox = new GatewayInbox(options.inboxCapacity);
    this.agent.on("message", (message) => {
      this.inbox.push(message);
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
        delivery: ["long-polling", ...(this.webhookUrl ? ["webhook"] : [])],
        capabilities: ["text", "image", "video", "audio", "file", "read-receipts", "supervision"],
        limits: { attachmentBytes: MAX_ATTACHMENT_BYTES, textCharacters: 32_000 },
        endpoints: {
          health: "/health",
          capabilities: "/v1/capabilities",
          openapi: "/openapi.json",
          events: "/v1/events",
          send: "/v1/send",
          sendAttachment: "/v1/send/attachment",
        },
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      const limit = positiveInteger(Number.parseInt(url.searchParams.get("limit") ?? "10", 10), 10, 100) || 10;
      const waitSeconds = positiveInteger(Number.parseInt(url.searchParams.get("waitSeconds") ?? "0", 10), 0, 30);
      const messages = await this.inbox.take(limit, waitSeconds);
      sendJson(response, 200, { events: messages.map(serializeGatewayMessage), pendingEvents: this.inbox.pending });
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
      const data = await readBody(request, MAX_ATTACHMENT_BYTES);
      if (data.byteLength === 0) throw new HttpError(400, "INVALID_REQUEST", "Attachment body cannot be empty");
      const name = safeFileName(url.searchParams.get("name") ?? headerString(request, "x-atalk-filename") ?? "attachment");
      const mimeType = request.headers["content-type"] ?? "application/octet-stream";
      const caption = url.searchParams.get("caption") ?? headerString(request, "x-atalk-caption");
      const conversationId = url.searchParams.get("conversationId") ?? undefined;
      const input = { data: new Uint8Array(data), name, mimeType, ...(caption ? { caption } : {}) };
      const sent: SentMessage = conversationId
        ? { conversationId, messageId: await this.agent.sendAttachmentInConversation(to, input, conversationId) }
        : await this.agent.sendAttachmentWithDetails(to, input);
      sendJson(response, 201, sent);
      return;
    }

    const match = /^\/v1\/messages\/([^/]+)(\/attachment|\/reply|\/reply\/attachment|\/read)$/u.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2]!;
      const message = messageOrThrow(this.inbox, id);
      if (request.method === "GET" && action === "/attachment") {
        if (!message.attachment) throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "The selected message has no attachment");
        const descriptor = message.attachment.descriptor;
        const bytes = Buffer.from(await message.attachment.download());
        response.writeHead(200, {
          "content-type": descriptor.mimeType,
          "content-length": bytes.byteLength,
          "content-disposition": `attachment; filename="${safeFileName(descriptor.name)}"`,
          "cache-control": "no-store",
        });
        response.end(bytes);
        return;
      }
      if (request.method === "POST" && action === "/read") {
        await message.markRead();
        sendJson(response, 200, { messageId: id, state: "READ" });
        return;
      }
      if (request.method === "POST" && action === "/reply") {
        const body = await readJson(request);
        const text = requiredString(body, "text", 32_000);
        const messageId = await replyText(message, text);
        sendJson(response, 201, { messageId, conversationId: message.conversationId });
        return;
      }
      if (request.method === "POST" && action === "/reply/attachment") {
        const data = await readBody(request, MAX_ATTACHMENT_BYTES);
        if (data.byteLength === 0) throw new HttpError(400, "INVALID_REQUEST", "Attachment body cannot be empty");
        const name = safeFileName(url.searchParams.get("name") ?? headerString(request, "x-atalk-filename") ?? "attachment");
        const mimeType = request.headers["content-type"] ?? "application/octet-stream";
        const caption = url.searchParams.get("caption") ?? headerString(request, "x-atalk-caption");
        const messageId = await replyAttachment(message, new Uint8Array(data), name, mimeType, caption);
        sendJson(response, 201, { messageId, conversationId: message.conversationId });
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

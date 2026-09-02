import { GATEWAY_SPEC, MAX_ATTACHMENT_BYTES } from "./constants.js";

export function gatewayOpenApiDocument(serverUrl = "http://127.0.0.1:8788") {
  const error = {
    description: "Gateway error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "aTalk Agent Gateway",
      version: "1.0.0",
      description: "Runtime-neutral local API for encrypted aTalk text and multimedia messaging.",
    },
    servers: [{ url: serverUrl }],
    externalDocs: { url: "https://github.com/atalk-network/atalk-developers/tree/main/integrations/gateway" },
    paths: {
      "/health": {
        get: {
          operationId: "gatewayHealth",
          security: [],
          responses: { "200": { description: "Gateway liveness and, when authorized, aTalk connectivity" } },
        },
      },
      "/v1/capabilities": {
        get: {
          operationId: "gatewayCapabilities",
          responses: { "200": { description: "Supported delivery modes, media, and limits" }, "401": error },
        },
      },
      "/v1/events": {
        get: {
          operationId: "receiveEvents",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
            { name: "waitSeconds", in: "query", schema: { type: "integer", minimum: 0, maximum: 30, default: 0 } },
          ],
          responses: {
            "200": {
              description: "Queued incoming events",
              content: { "application/json": { schema: { type: "object", required: ["events", "pendingEvents"], properties: {
                events: { type: "array", items: { $ref: "#/components/schemas/MessageEvent" } },
                pendingEvents: { type: "integer" },
              } } } },
            },
            "401": error,
          },
        },
      },
      "/v1/send": {
        post: {
          operationId: "sendText",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            required: ["to", "text"],
            properties: {
              to: { type: "string", examples: ["@recipient"] },
              text: { type: "string", maxLength: 32_000 },
              conversationId: { type: "string", description: "Include to continue an existing conversation" },
            },
          } } } },
          responses: { "201": { $ref: "#/components/responses/Sent" }, "400": error, "401": error },
        },
      },
      "/v1/send/attachment": {
        post: {
          operationId: "sendAttachment",
          parameters: [
            { name: "to", in: "query", required: true, schema: { type: "string" } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "caption", in: "query", schema: { type: "string", maxLength: 4_000 } },
            { name: "conversationId", in: "query", schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary", maxLength: MAX_ATTACHMENT_BYTES } } } },
          responses: { "201": { $ref: "#/components/responses/Sent" }, "400": error, "401": error, "413": error },
        },
      },
      "/v1/messages/{messageId}/attachment": {
        get: {
          operationId: "downloadAttachment",
          parameters: [{ $ref: "#/components/parameters/MessageId" }],
          responses: { "200": { description: "Decrypted attachment bytes" }, "401": error, "404": error },
        },
      },
      "/v1/messages/{messageId}/reply": {
        post: {
          operationId: "replyText",
          parameters: [{ $ref: "#/components/parameters/MessageId" }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 32_000 } },
          } } } },
          responses: { "201": { $ref: "#/components/responses/Sent" }, "400": error, "401": error, "404": error },
        },
      },
      "/v1/messages/{messageId}/reply/attachment": {
        post: {
          operationId: "replyAttachment",
          parameters: [
            { $ref: "#/components/parameters/MessageId" },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "caption", in: "query", schema: { type: "string", maxLength: 4_000 } },
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary", maxLength: MAX_ATTACHMENT_BYTES } } } },
          responses: { "201": { $ref: "#/components/responses/Sent" }, "400": error, "401": error, "404": error, "413": error },
        },
      },
      "/v1/messages/{messageId}/read": {
        post: {
          operationId: "markRead",
          parameters: [{ $ref: "#/components/parameters/MessageId" }],
          responses: { "200": { description: "Read receipt sent" }, "401": error, "404": error },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        gatewayKey: { type: "apiKey", in: "header", name: "X-aTalk-Gateway-Key" },
      },
      parameters: {
        MessageId: { name: "messageId", in: "path", required: true, schema: { type: "string" } },
      },
      responses: {
        Sent: {
          description: "Encrypted message accepted by the local aTalk transport",
          content: { "application/json": { schema: { $ref: "#/components/schemas/SentMessage" } } },
        },
      },
      schemas: {
        SentMessage: {
          type: "object", required: ["conversationId", "messageId"], properties: {
            conversationId: { type: "string" }, messageId: { type: "string" },
          },
        },
        MessageEvent: {
          type: "object",
          required: ["specVersion", "id", "type", "occurredAt", "data", "actions"],
          properties: {
            specVersion: { const: "1.0" },
            id: { type: "string" },
            type: { const: "message.received" },
            occurredAt: { type: "string", format: "date-time" },
            data: { type: "object" },
            actions: { type: "object" },
          },
        },
        Error: {
          type: "object", required: ["error"], properties: {
            error: { type: "object", required: ["code", "message"], properties: {
              code: { type: "string" }, message: { type: "string" },
            } },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }, { gatewayKey: [] }],
    "x-atalk-spec": GATEWAY_SPEC,
  } as const;
}

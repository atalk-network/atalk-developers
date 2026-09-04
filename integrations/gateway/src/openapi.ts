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
      description: "Runtime-neutral local API for encrypted aTalk messaging and permission-aware Tasks/Workrooms.",
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
            {
              name: "mode", in: "query",
              description: "Use explicit for non-destructive delivery followed by the event ack action",
              schema: { type: "string", enum: ["legacy", "explicit"], default: "legacy" },
            },
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
      "/v1/messages/{messageId}/ack": {
        post: {
          operationId: "acknowledgeEvent",
          description: "Remove an event returned by /v1/events?mode=explicit from the durable inbox.",
          parameters: [{ $ref: "#/components/parameters/MessageId" }],
          responses: { "200": { description: "Event consumption committed" }, "401": error, "404": error },
        },
      },
      "/v1/workrooms": {
        get: {
          operationId: "listWorkrooms",
          description: "List Tasks/Workrooms available to the active agent.",
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: { "200": { description: "Task metadata with locally verified/decrypted descriptor, membership and mandates" }, "401": error },
        },
      },
      "/v1/workrooms/{workroomId}": {
        get: {
          operationId: "getWorkroom",
          parameters: [{ $ref: "#/components/parameters/WorkroomId" }],
          responses: { "200": { description: "Workroom, threads, members, mandates and approvals" }, "401": error, "404": error },
        },
      },
      "/v1/workrooms/{workroomId}/events": {
        get: {
          operationId: "receiveWorkroomEvents",
          description: "By default, durably decrypt and return only events explicitly directed to this agent. scope=audit is a stateless operator view of all events and must not drive an agent loop.",
          parameters: [
            { $ref: "#/components/parameters/WorkroomId" },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
            { name: "scope", in: "query", schema: { type: "string", enum: ["directed", "audit"], default: "directed" } },
            { name: "afterSequence", in: "query", description: "Audit scope only", schema: { type: "integer", minimum: 0, default: 0 } },
          ],
          responses: { "200": { description: "Directed automation events, or complete events when audit scope is explicit" }, "400": error, "401": error, "404": error },
        },
        post: {
          operationId: "publishWorkroomEvent",
          description: "Low-level encrypted publication for trusted/manual clients. Agent runtimes should use /execute so the current signed agent permission is enforced.",
          parameters: [{ $ref: "#/components/parameters/WorkroomId" }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["threadId", "payload"], properties: {
            threadId: { type: "string", format: "uuid" }, payload: { type: "object" }, eventId: { type: "string", format: "uuid" },
            idempotencyKey: { type: "string" }, projection: { type: "object" },
          } } } } },
          responses: { "201": { description: "Encrypted event accepted" }, "400": error, "401": error, "404": error },
        },
      },
      "/v1/workrooms/{workroomId}/execute": {
        post: {
          operationId: "executeWorkroomPublication",
          description: "Validate the current signed agent permission (mandate in the API) immediately before encrypted publication. Approval requests are created automatically; denied or pending actions are not executed.",
          parameters: [{ $ref: "#/components/parameters/WorkroomId" }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["threadId", "operationId", "payload"],
            properties: {
              threadId: { type: "string", format: "uuid" },
              operationId: { type: "string", format: "uuid", description: "Stable across retries" },
              mandateId: { type: "string", format: "uuid" },
              rationale: { type: "string", maxLength: 4_000 },
              payload: { type: "object" },
            },
          } } } },
          responses: {
            "201": { description: "Executed and followed by a signed receipt" },
            "202": { description: "Approval requested; publication not executed" },
            "400": error, "401": error, "403": { description: "Denied by the current agent permission" }, "404": error,
          },
        },
      },
      "/v1/workrooms/{workroomId}/attachments": {
        post: {
          operationId: "uploadWorkroomAttachment",
          parameters: [
            { $ref: "#/components/parameters/WorkroomId" },
            { name: "name", in: "query", schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary", maxLength: MAX_ATTACHMENT_BYTES } } } },
          responses: { "201": { description: "Encrypted group-scoped attachment descriptor" }, "400": error, "401": error, "413": error },
        },
      },
      "/v1/workrooms/{workroomId}/attachments/download": {
        post: {
          operationId: "downloadWorkroomAttachment",
          parameters: [{ $ref: "#/components/parameters/WorkroomId" }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["descriptor"], properties: { descriptor: { type: "object" } } } } } },
          responses: { "200": { description: "Authenticated decrypted attachment bytes" }, "400": error, "401": error, "404": error },
        },
      },
      "/v1/workrooms/{workroomId}/attachments/submit": {
        post: {
          operationId: "submitMandatedWorkroomAttachment",
          description: "Permission-check, encrypt, upload and publish one artifact version, followed by a signed receipt.",
          parameters: [
            { $ref: "#/components/parameters/WorkroomId" },
            { name: "threadId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
            { name: "operationId", in: "query", required: true, description: "Stable across retries", schema: { type: "string", format: "uuid" } },
            { name: "name", in: "query", schema: { type: "string" } },
            { name: "title", in: "query", schema: { type: "string" } },
            { name: "mentions", in: "query", description: "URL-encoded JSON array of structured mentions", schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", contentEncoding: "binary", maxLength: MAX_ATTACHMENT_BYTES } } } },
          responses: {
            "201": { description: "Encrypted artifact published and receipted" },
            "202": { description: "Approval requested; bytes were not uploaded" },
            "400": error, "401": error, "403": { description: "Denied by the current agent permission" }, "413": error,
          },
        },
      },
      "/v1/workrooms/{workroomId}/attachments/read": {
        post: {
          operationId: "readMandatedWorkroomAttachment",
          description: "Check file.read in the current agent permission, then authenticate and decrypt a Task attachment locally.",
          parameters: [{ $ref: "#/components/parameters/WorkroomId" }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["threadId", "operationId", "descriptor"], properties: {
              threadId: { type: "string", format: "uuid" },
              operationId: { type: "string", format: "uuid" },
              mandateId: { type: "string", format: "uuid" },
              rationale: { type: "string", maxLength: 4_000 },
              descriptor: { type: "object" },
            },
          } } } },
          responses: {
            "200": { description: "Authenticated decrypted bytes; never exposed to the relay" },
            "202": { description: "Approval requested; file was not decrypted" },
            "400": error, "401": error, "403": { description: "Denied by the current agent permission" }, "404": error,
          },
        },
      },
      "/v1/workrooms/{workroomId}/mandates/guard": {
        post: {
          operationId: "guardMandatedAction",
          description: "Preview technical mandate evaluation. This is not an execution boundary; use /execute or the permission-aware attachment endpoints for effects and signed receipts.",
          parameters: [{ $ref: "#/components/parameters/WorkroomId" }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "permitted, requires_approval, or denied" }, "400": error, "401": error, "404": error },
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
        WorkroomId: { name: "workroomId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
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
        AgentMention: {
          type: "object",
          required: ["peerId", "handle", "type"],
          properties: {
            peerId: { type: "string", format: "uuid" },
            handle: { type: "string" },
            type: { const: "AGENT" },
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
            data: {
              type: "object",
              required: ["messageId", "conversationId", "text", "sender", "isSupervisor", "mentions", "isMentioned"],
              properties: {
                messageId: { type: "string", format: "uuid" },
                conversationId: { type: "string", format: "uuid" },
                text: { type: "string" },
                sender: { type: "object" },
                isSupervisor: { type: "boolean" },
                mentions: { type: "array", items: { $ref: "#/components/schemas/AgentMention" } },
                isMentioned: { type: "boolean" },
                attachment: { type: "object" },
              },
            },
            actions: {
              type: "object",
              required: ["reply", "replyAttachment", "markRead", "ack"],
              properties: {
                reply: { type: "string" },
                replyAttachment: { type: "string" },
                markRead: { type: "string" },
                ack: { type: "string" },
              },
            },
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

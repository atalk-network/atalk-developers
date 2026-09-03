import type { IncomingMessage } from "@atalk/sdk";
import { describe, expect, it } from "vitest";
import { serializeMessage } from "./inbox.js";

describe("MCP inbox serialization", () => {
  it("exposes safe voice metadata without attachment secrets", () => {
    const message = {
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      text: "Voice note",
      sender: { id: "33333333-3333-4333-8333-333333333333", type: "HUMAN", handle: "@sender", displayName: "Sender" },
      receivedAt: new Date(0),
      isSupervisor: false,
      mentions: [{ peerId: "44444444-4444-4444-8444-444444444444", handle: "@agent", type: "AGENT" }],
      isMentioned: true,
      attachment: {
        descriptor: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "FILE",
          name: "voice-message.m4a",
          mimeType: "audio/mp4",
          size: 42,
          sha256: "secret-digest",
          encryption: { algorithm: "XCHACHA20_POLY1305", key: "secret-key", nonce: "secret-nonce" },
        },
      },
    } as IncomingMessage;

    const serialized = serializeMessage(message);
    expect(serialized.attachment).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "FILE",
      name: "voice-message.m4a",
      mimeType: "audio/mp4",
      size: 42,
    });
    expect(JSON.stringify(serialized)).not.toContain("secret-key");
    expect(JSON.stringify(serialized)).not.toContain("secret-nonce");
    expect(serialized.mentions).toEqual([{ peerId: "44444444-4444-4444-8444-444444444444", handle: "@agent", type: "AGENT" }]);
    expect(serialized.isMentioned).toBe(true);
  });
});

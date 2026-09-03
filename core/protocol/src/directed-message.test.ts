import { describe, expect, it } from "vitest";
import { decodeDirectedMessage, encodeDirectedMessage } from "./directed-message.js";

describe("directed message payload", () => {
  it("round-trips encrypted mention metadata without changing the inner content", () => {
    const message = {
      version: 1 as const,
      kind: "DIRECTED_MESSAGE" as const,
      content: "Revisá el precio antes de responder.",
      mentions: [{
        peerId: "11111111-1111-4111-8111-111111111111",
        handle: "@research.acme",
        type: "AGENT" as const,
      }],
    };
    expect(decodeDirectedMessage(encodeDirectedMessage(message))).toEqual(message);
  });

  it("ignores ordinary text and malformed directed payloads", () => {
    expect(decodeDirectedMessage("Hola")).toBeUndefined();
    expect(decodeDirectedMessage("__ATALK_DIRECTED_MESSAGE_V1__invalid")).toBeUndefined();
  });
});

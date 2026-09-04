import { describe, expect, it } from "vitest";

import { generateIdentityKeys } from "./crypto.js";
import {
  hashWorkroomReceipt,
  signWorkroomReceipt,
  verifyReceiptChain,
  verifyWorkroomReceipt,
} from "./workroom-receipts.js";

const WORKROOM_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-03T12:00:00.000Z";

describe("workroom receipt chain", () => {
  it("verifies signed append-only receipts and detects forks or mutation", () => {
    const keys = generateIdentityKeys();
    const first = signWorkroomReceipt({
      version: 1,
      receiptId: "33333333-3333-4333-8333-333333333333",
      workroomId: WORKROOM_ID,
      actorPeerId: ACTOR_ID,
      signingPublicKey: keys.signingPublicKey,
      event: "workroom_created",
      idempotencyKey: "create-0001",
      payloadHash: "cGF5bG9hZDE",
      previousReceiptHash: null,
      outcome: "accepted",
      occurredAt: NOW,
    }, keys.signingSecretKey);
    const second = signWorkroomReceipt({
      version: 1,
      receiptId: "44444444-4444-4444-8444-444444444444",
      workroomId: WORKROOM_ID,
      actorPeerId: ACTOR_ID,
      signingPublicKey: keys.signingPublicKey,
      event: "event_appended",
      subjectId: "55555555-5555-4555-8555-555555555555",
      idempotencyKey: "message-0001",
      payloadHash: "cGF5bG9hZDI",
      previousReceiptHash: hashWorkroomReceipt(first),
      outcome: "recorded",
      occurredAt: "2026-09-03T12:01:00.000Z",
    }, keys.signingSecretKey);

    expect(verifyWorkroomReceipt(first, keys.signingPublicKey)).toBe(true);
    expect(verifyWorkroomReceipt(second, keys.signingPublicKey)).toBe(true);
    expect(verifyReceiptChain([first, second])).toBe(true);
    expect(verifyReceiptChain([{ ...first, signature: "dGFtcGVyZWQ" }, second])).toBe(false);
    expect(verifyReceiptChain([second])).toBe(false);
  });
});

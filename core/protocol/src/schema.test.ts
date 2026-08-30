import { describe, expect, it } from "vitest";
import { publicPeerSchema } from "./schema.js";

const basePeer = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "HUMAN",
  status: "ACTIVE",
  handle: "@compat.user",
  displayName: "Compatibility User",
  signingPublicKey: "signing-public-key-12345",
  encryptionPublicKey: "encryption-public-key-12345",
} as const;

describe("public peer wire compatibility", () => {
  it("fills privacy-first defaults when reading an older server response", () => {
    expect(publicPeerSchema.parse(basePeer)).toMatchObject({
      publicDiscoverable: false,
      organizationDiscoverable: true,
    });
  });

  it("ignores additive response fields from a newer server", () => {
    expect(publicPeerSchema.parse({ ...basePeer, futureCapability: "supported" }))
      .not.toHaveProperty("futureCapability");
  });
});

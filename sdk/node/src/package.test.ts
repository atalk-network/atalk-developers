import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentityKeys } from "@atalk/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "./credential-store.js";
import { RUST_CORE_VERSION } from "./native-core.js";

describe("published Node SDK surface", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("loads the Rust core and secures persisted credentials", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-test-"));
    const path = join(directory, "credentials.json");
    const store = new FileCredentialStore("activation-token", path);
    const keys = generateIdentityKeys();
    const credentials = {
      sessionToken: "session-token",
      peer: {
        id: "00000000-0000-4000-8000-000000000001",
        type: "AGENT" as const,
        status: "ACTIVE" as const,
        handle: "@test.agent",
        displayName: "Test agent",
        ownerPeerId: "00000000-0000-4000-8000-000000000002",
        signingPublicKey: keys.signingPublicKey,
        encryptionPublicKey: keys.encryptionPublicKey,
      },
      keys,
    };

    expect(RUST_CORE_VERSION).toBe("0.1.0");
    await store.save(credentials);
    await expect(store.load()).resolves.toEqual(credentials);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

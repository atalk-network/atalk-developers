import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { type AgentCredentials, type CredentialStore } from "./credential-store.js";
import { MemoryRuntimeStateStore } from "./runtime-state-store.js";
import {
  ATALK_SDK_VERSION,
  isManagedRuntimeProcess,
  parseRuntimeUpdateAdvisory,
  persistRuntimeUpdateStatus,
  resolveRuntimeCheckIn,
  type RuntimeUpdateAdvisory,
} from "./runtime-update.js";

class MemoryCredentials implements CredentialStore {
  async load(): Promise<AgentCredentials | undefined> { return undefined; }
  async save(): Promise<void> {}
}

describe("agent runtime update metadata", () => {
  let directory: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("builds the exact wire shape and defaults custom integrations to the SDK version", () => {
    expect(resolveRuntimeCheckIn(undefined)).toEqual({
      sdk: { name: "@atalk/sdk", version: ATALK_SDK_VERSION },
      integration: { name: "custom", version: ATALK_SDK_VERSION },
      protocolVersion: 1,
      channel: "PREVIEW",
      capabilities: ["attachments", "directed-mentions", "e2ee", "supervision", "text", "workrooms"],
    });
    expect(resolveRuntimeCheckIn({
      integration: { name: "@example/bridge", version: "2.3.4" },
      host: { name: "example-host", version: "8.0.0" },
      channel: "STABLE",
      capabilities: ["text", "text", "images"],
    })).toEqual({
      sdk: { name: "@atalk/sdk", version: ATALK_SDK_VERSION },
      integration: { name: "@example/bridge", version: "2.3.4" },
      host: { name: "example-host", version: "8.0.0" },
      protocolVersion: 1,
      channel: "STABLE",
      capabilities: ["images", "text"],
    });
  });

  it("rejects metadata the relay schema would reject", () => {
    expect(() => resolveRuntimeCheckIn({ integration: { name: "bad name", version: "1.0.0" } }))
      .toThrow("check-in schema");
    expect(() => resolveRuntimeCheckIn({ integration: { name: "valid", version: "version with spaces" } }))
      .toThrow("check-in schema");
    expect(() => resolveRuntimeCheckIn({ capabilities: ["invalid capability"] }))
      .toThrow("check-in schema");
    expect(() => resolveRuntimeCheckIn({ capabilities: Array.from({ length: 65 }, (_, index) => `capability.${index}`) }))
      .toThrow("at most 64");
  });

  it("parses advisories defensively", () => {
    expect(parseRuntimeUpdateAdvisory({
      status: "UPDATE_AVAILABLE",
      currentVersion: ATALK_SDK_VERSION,
      recommendedVersion: "0.1.0-alpha.15",
      severity: "SECURITY",
      releaseNotesUrl: "https://docs.atalk.ar/releases/alpha.15",
      policy: "SECURITY",
      checkedAt: "2026-09-04T12:00:00.000Z",
    })).toMatchObject({ status: "UPDATE_AVAILABLE", recommendedVersion: "0.1.0-alpha.15" });
    expect(parseRuntimeUpdateAdvisory({ status: "CURRENT" })).toBeUndefined();
    expect(parseRuntimeUpdateAdvisory({
      status: "CURRENT",
      currentVersion: ATALK_SDK_VERSION,
      severity: "INFO",
      policy: "NOTIFY",
      checkedAt: "not-a-date",
    })).toBeUndefined();
  });

  it("persists a private, atomic supervisor handoff file", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-runtime-update-"));
    const path = join(directory, "nested", "status.json");
    const metadata = resolveRuntimeCheckIn(undefined);
    const advisory = advisoryFixture();
    const launchId = "11111111-1111-4111-8111-111111111111";
    vi.stubEnv("ATALK_RUNTIME_LAUNCH_ID", launchId);
    await persistRuntimeUpdateStatus(path, metadata, advisory);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      writerProcessId: process.pid,
      writerLaunchId: launchId,
      metadata,
      advisory,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("accepts auto-update capability only with a live parent lease", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-runtime-lease-"));
    const lease = join(directory, "supervisor.lock");
    const supervisorNonce = "22222222-2222-4222-8222-222222222222";
    const launchId = "33333333-3333-4333-8333-333333333333";
    await writeFile(lease, JSON.stringify({ pid: 1234, nonce: supervisorNonce }));
    const environment = {
      ATALK_RUNTIME_MANAGED: "1",
      ATALK_RUNTIME_SUPERVISOR_LEASE: lease,
      ATALK_RUNTIME_SUPERVISOR_NONCE: supervisorNonce,
      ATALK_RUNTIME_LAUNCH_ID: launchId,
    };
    expect(isManagedRuntimeProcess(environment, 1234, true)).toBe(true);
    expect(isManagedRuntimeProcess(environment, 1234, false)).toBe(false);
    expect(isManagedRuntimeProcess(environment, 4321, true)).toBe(false);
    expect(isManagedRuntimeProcess({ ...environment, ATALK_RUNTIME_SUPERVISOR_NONCE: launchId }, 1234, true)).toBe(false);
    expect(isManagedRuntimeProcess({ ATALK_RUNTIME_MANAGED: "1" }, 1234, true)).toBe(false);
  });

  it("checks in without affecting the message channel and only emits material changes", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-runtime-check-in-"));
    const statusPath = join(directory, "update.json");
    const bodies: unknown[] = [];
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      runtime: {
        integration: { name: "@example/test", version: "1.2.3" },
        updateStatusPath: statusPath,
      },
    });
    const update = vi.fn();
    const messages = vi.fn();
    agent.on("update", update);
    agent.on("message", messages);
    const responses = [advisoryFixture(), { ...advisoryFixture(), checkedAt: "2026-09-04T18:00:00.000Z" }];
    const internals = agent as unknown as {
      fetchRuntimeCheckIn(init: RequestInit): Promise<Response>;
      checkInRuntimeSafely(): Promise<void>;
    };
    internals.fetchRuntimeCheckIn = vi.fn(async (init: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ advisory: responses.shift() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await internals.checkInRuntimeSafely();
    await internals.checkInRuntimeSafely();
    await Promise.resolve();

    expect(bodies[0]).toEqual(agent.runtimeMetadata);
    expect(update).toHaveBeenCalledTimes(1);
    expect(messages).not.toHaveBeenCalled();
    expect(agent.runtimeUpdate?.recommendedVersion).toBe("0.1.0-alpha.15");
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
      version: 1,
      advisory: { checkedAt: "2026-09-04T18:00:00.000Z" },
    });
  });

  it("tolerates an older relay without a check-in endpoint", async () => {
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      runtime: { updateStatusPath: false },
    });
    const error = vi.fn();
    agent.on("error", error);
    const internals = agent as unknown as {
      fetchRuntimeCheckIn(init: RequestInit): Promise<Response>;
      checkInRuntimeSafely(): Promise<void>;
    };
    internals.fetchRuntimeCheckIn = vi.fn(async () => new Response(null, { status: 404 }));
    await internals.checkInRuntimeSafely();
    expect(agent.runtimeUpdate).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
  });

  it("bounds a hung advisory endpoint without failing the runtime", async () => {
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      runtime: { updateStatusPath: false, checkInTimeoutMs: 10 },
    });
    const error = vi.fn();
    agent.on("error", error);
    const internals = agent as unknown as {
      fetchRuntimeCheckIn(init: RequestInit): Promise<Response>;
    };
    internals.fetchRuntimeCheckIn = vi.fn(async (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    await expect(agent.checkForRuntimeUpdate()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(agent.connected).toBe(false);
  });

  it("refreshes an expired access token once within the same advisory deadline", async () => {
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      runtime: { updateStatusPath: false, checkInTimeoutMs: 100 },
    });
    (agent as unknown as { credentials: AgentCredentials }).credentials = credentialFixture();
    const authorizations: Array<string | null> = [];
    const refreshSignals: AbortSignal[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/agent-runtime/session/refresh")) {
        if (init?.signal) refreshSignals.push(init.signal);
        return new Response(JSON.stringify({ accessToken: "fresh-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (authorizations.length === 1) return new Response(null, { status: 401 });
      return new Response(JSON.stringify({ advisory: advisoryFixture() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(agent.checkForRuntimeUpdate()).resolves.toMatchObject({ status: "UPDATE_AVAILABLE" });
    expect(refreshSignals).toHaveLength(1);
    expect(refreshSignals[0]).toBeInstanceOf(AbortSignal);
    expect(authorizations).toEqual(["Bearer expired-access-token", "Bearer fresh-access-token"]);
  });

  it("never lets advisory auth poison the shared custom credential refresh path", async () => {
    let allowRefresh = false;
    const refreshCredentials = vi.fn(async (_context: { signal?: AbortSignal }) => allowRefresh
      ? { accessToken: "fresh-access-token" }
      : new Promise<never>(() => undefined));
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      refreshCredentials,
      runtime: { updateStatusPath: false, checkInTimeoutMs: 15 },
    });
    (agent as unknown as { credentials: AgentCredentials }).credentials = credentialFixture();
    const error = vi.fn();
    agent.on("error", error);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));

    await expect(agent.checkForRuntimeUpdate()).resolves.toBeUndefined();
    expect(refreshCredentials).not.toHaveBeenCalled();
    expect((agent as unknown as { refreshPromise?: Promise<boolean> }).refreshPromise).toBeUndefined();

    allowRefresh = true;
    const internals = agent as unknown as {
      refreshCredentialsIfNeeded(reason: "UNAUTHORIZED", force: boolean): Promise<boolean>;
    };
    await expect(internals.refreshCredentialsIfNeeded("UNAUTHORIZED", true)).resolves.toBe(true);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("does not await advisory hooks or propagate exceptions from observability callbacks", async () => {
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      runtime: { updateStatusPath: false },
    });
    const hangingUpdate = vi.fn(async () => new Promise<never>(() => undefined));
    agent.on("update", hangingUpdate);
    agent.on("error", () => { throw new Error("observer failed"); });
    const internals = agent as unknown as {
      fetchRuntimeCheckIn(init: RequestInit): Promise<Response>;
      checkInRuntimeSafely(): Promise<void>;
    };
    internals.fetchRuntimeCheckIn = vi.fn(async () => new Response(JSON.stringify({
      advisory: advisoryFixture(),
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(internals.checkInRuntimeSafely()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(hangingUpdate).toHaveBeenCalledTimes(1);

    agent.on("update", () => { throw new Error("update observer failed"); });
    internals.fetchRuntimeCheckIn = vi.fn(async () => new Response(JSON.stringify({
      advisory: { ...advisoryFixture(), recommendedVersion: "0.1.0-alpha.16" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(internals.checkInRuntimeSafely()).resolves.toBeUndefined();
    await Promise.resolve();

    internals.fetchRuntimeCheckIn = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(internals.checkInRuntimeSafely()).resolves.toBeUndefined();
  });

  it("does not wait for a hung advisory when preparing the authenticated message connection", async () => {
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
      runtime: { updateStatusPath: false },
    });
    const checkStarted = vi.fn();
    const internals = agent as unknown as {
      connectWithRefresh(): Promise<void>;
      checkInRuntimeSafely(): Promise<void>;
      scheduleRuntimeCheckIn(): void;
      prepareAndConnect(): Promise<void>;
    };
    internals.connectWithRefresh = async () => undefined;
    internals.checkInRuntimeSafely = async () => {
      checkStarted();
      await new Promise<void>(() => undefined);
    };
    internals.scheduleRuntimeCheckIn = vi.fn();

    await expect(internals.prepareAndConnect()).resolves.toBeUndefined();
    expect(checkStarted).toHaveBeenCalledTimes(1);
    expect(internals.scheduleRuntimeCheckIn).toHaveBeenCalledTimes(1);
  });
});

function advisoryFixture(): RuntimeUpdateAdvisory {
  return {
    status: "UPDATE_AVAILABLE",
    currentVersion: ATALK_SDK_VERSION,
    recommendedVersion: "0.1.0-alpha.15",
    severity: "INFO",
    releaseNotesUrl: "https://docs.atalk.ar/releases/alpha.15",
    policy: "NOTIFY",
    checkedAt: "2026-09-04T12:00:00.000Z",
  };
}

function credentialFixture(): AgentCredentials {
  return {
    sessionToken: "expired-access-token",
    accessToken: "expired-access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: "2026-09-04T00:00:00.000Z",
    peer: {
      id: "00000000-0000-4000-8000-000000000001",
      type: "AGENT",
      status: "ACTIVE",
      handle: "@runtime.test",
      displayName: "Runtime test",
      publicDiscoverable: false,
      organizationDiscoverable: false,
      signingPublicKey: "signing-public",
      encryptionPublicKey: "encryption-public",
    },
    keys: {
      signingPublicKey: "signing-public",
      signingSecretKey: "signing-secret",
      encryptionPublicKey: "encryption-public",
      encryptionSecretKey: "encryption-secret",
    },
  };
}

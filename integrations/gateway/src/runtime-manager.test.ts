import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANAGED_GATEWAY_PACKAGE,
  NodeRuntimeManager,
  decideRuntimeUpdate,
  defaultRuntimeManagerPaths,
  parseRuntimeDependencyLock,
  parseRuntimeHealthReport,
  sanitizedInstallerEnvironment,
  verifyNpmAuditReport,
  verifyNpmArtifactIntegrity,
  verifyNpmDependencyLockGraph,
  type ManagedRuntimeChild,
  type NpmRuntimeArtifact,
  type RuntimeManagerDependencies,
} from "./runtime-manager.js";
import type { PersistedRuntimeUpdateStatus, RuntimeUpdateAdvisory } from "@atalk/sdk";
import { createAtalkGateway } from "./gateway.js";

describe("safe Node Runtime Manager", () => {
  let directory: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("keeps operator and server policy as a joint ceiling", () => {
    const update = advisory({ policy: "COMPATIBLE", severity: "INFO" });
    expect(decideRuntimeUpdate(update, "0.1.0-alpha.14", "NOTIFY")).toMatchObject({ action: "NOTIFY" });
    expect(decideRuntimeUpdate(update, "0.1.0-alpha.14", "SECURITY")).toMatchObject({ action: "NOTIFY" });
    expect(decideRuntimeUpdate(update, "0.1.0-alpha.14", "COMPATIBLE")).toMatchObject({
      action: "UPDATE",
      candidateVersion: "0.1.0-alpha.15",
    });
    expect(decideRuntimeUpdate(advisory({ policy: "SECURITY", severity: "SECURITY" }), "0.1.0-alpha.14", "COMPATIBLE"))
      .toMatchObject({ action: "UPDATE", effectivePolicy: "SECURITY" });
    expect(decideRuntimeUpdate(advisory({ policy: "NOTIFY", severity: "SECURITY" }), "0.1.0-alpha.14", "COMPATIBLE"))
      .toMatchObject({ action: "NOTIFY", effectivePolicy: "NOTIFY" });
  });

  it("fails closed on an invalid embedded local policy", () => {
    expect(() => new NodeRuntimeManager({
      bootstrapEntrypoint: "/tmp/atalk-bootstrap.js",
      localPolicy: "TYPO" as never,
    })).toThrow("localPolicy must be");
  });

  it("isolates default supervisor state for every paired agent credential", () => {
    const first = defaultRuntimeManagerPaths("/tmp/atalk-agent-a.json");
    const second = defaultRuntimeManagerPaths("/tmp/atalk-agent-b.json");
    expect(first.stateDirectory).not.toBe(second.stateDirectory);
    expect(defaultRuntimeManagerPaths("/tmp/atalk-agent-a.json").stateDirectory).toBe(first.stateDirectory);
  });

  it("accepts only an exact signed dependency allowlist for the Gateway release", () => {
    expect(parseRuntimeDependencyLock({
      version: 1,
      root: { name: MANAGED_GATEWAY_PACKAGE, version: "0.1.0-alpha.15" },
      packages: { [MANAGED_GATEWAY_PACKAGE]: "0.1.0-alpha.15", ws: "8.21.3" },
      required: [MANAGED_GATEWAY_PACKAGE, "ws"],
    }, "0.1.0-alpha.15")).toMatchObject({ packages: { ws: "8.21.3" } });
    expect(() => parseRuntimeDependencyLock({
      version: 1,
      root: { name: MANAGED_GATEWAY_PACKAGE, version: "0.1.0-alpha.15" },
      packages: { [MANAGED_GATEWAY_PACKAGE]: "0.1.0-alpha.15", ws: "latest" },
      required: [MANAGED_GATEWAY_PACKAGE, "ws"],
    }, "0.1.0-alpha.15")).toThrow("invalid package pin");
  });

  it("rejects drift, omissions, and a mismatched root in the installed npm lock", () => {
    const artifact = artifactFixture("0.1.0-alpha.15");
    const dependencyLock = parseRuntimeDependencyLock({
      version: 1,
      root: { name: MANAGED_GATEWAY_PACKAGE, version: artifact.version },
      packages: { [MANAGED_GATEWAY_PACKAGE]: artifact.version, ws: "8.21.3" },
      required: [MANAGED_GATEWAY_PACKAGE, "ws"],
    }, artifact.version);
    const lock = {
      packages: {
        "": { dependencies: { [MANAGED_GATEWAY_PACKAGE]: artifact.version } },
        "node_modules/@atalk/gateway": {
          version: artifact.version,
          resolved: artifact.tarballUrl,
          integrity: artifact.integrity,
        },
        "node_modules/ws": { version: "8.21.3" },
      },
    };
    expect(() => verifyNpmDependencyLockGraph(lock, artifact, dependencyLock)).not.toThrow();
    expect(() => verifyNpmDependencyLockGraph({
      packages: { ...lock.packages, "node_modules/left-pad": { version: "1.3.0" } },
    }, artifact, dependencyLock)).toThrow("unapproved package");
    const missing = structuredClone(lock);
    delete (missing.packages as Record<string, unknown>)["node_modules/ws"];
    expect(() => verifyNpmDependencyLockGraph(missing, artifact, dependencyLock)).toThrow("missing required");
    const wrongRoot = structuredClone(lock);
    wrongRoot.packages["node_modules/@atalk/gateway"].resolved = "https://registry.npmjs.org/fake/wrong.tgz";
    expect(() => verifyNpmDependencyLockGraph(wrongRoot, artifact, dependencyLock)).toThrow("official Gateway artifact");
  });

  it("does not let a library caller forge Runtime Manager ownership", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-runtime-capability-"));
    const unmanaged = createAtalkGateway({ credentialPath: join(directory, "unmanaged.json") });
    const managed = createAtalkGateway({
      credentialPath: join(directory, "managed.json"),
      managedRuntime: true,
      runtimeUpdateStatusPath: join(directory, "managed-update.json"),
    });
    expect(unmanaged.agent.runtimeMetadata.capabilities).not.toContain("runtime.auto-update");
    expect(managed.agent.runtimeMetadata.capabilities).not.toContain("runtime.auto-update");
    await unmanaged.stop();
    await managed.stop();
  });

  it("verifies npm integrity and checksum before installation", () => {
    const bytes = Buffer.from("verified aTalk package");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const shasum = createHash("sha1").update(bytes).digest("hex");
    expect(() => verifyNpmArtifactIntegrity(bytes, integrity, shasum)).not.toThrow();
    expect(() => verifyNpmArtifactIntegrity(Buffer.from("tampered"), integrity, shasum)).toThrow("integrity verification failed");
  });

  it("requires a clean cryptographically verified Gateway provenance report", () => {
    const artifact = artifactFixture("0.1.0-alpha.15");
    const verified = {
      invalid: [],
      missing: [],
      verified: [{
        name: MANAGED_GATEWAY_PACKAGE,
        version: artifact.version,
        location: "node_modules/@atalk/gateway",
        registry: "https://registry.npmjs.org/",
        attestations: {
          url: artifact.provenanceUrl,
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
        attestationBundles: [officialProvenanceBundle(artifact)],
      }],
    };
    expect(() => verifyNpmAuditReport(verified, artifact)).not.toThrow();
    expect(() => verifyNpmAuditReport({ ...verified, verified: [] }, artifact)).toThrow("did not cryptographically verify");
    expect(() => verifyNpmAuditReport({ ...verified, missing: [{ name: MANAGED_GATEWAY_PACKAGE }] }, artifact))
      .toThrow("clean machine-verifiable report");
    const wrongSource = structuredClone(verified);
    const payload = wrongSource.verified[0]!.attestationBundles[0]!.bundle.dsseEnvelope.payload;
    const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      predicate: { buildDefinition: { externalParameters: { workflow: { repository: string } } } };
    };
    statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/example/compromised";
    wrongSource.verified[0]!.attestationBundles[0]!.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    expect(() => verifyNpmAuditReport(wrongSource, artifact)).toThrow("official aTalk release workflow");
  });

  it("uses a minimal unauthenticated environment for public npm verification", () => {
    const environment = sanitizedInstallerEnvironment({
      PATH: "/usr/bin",
      SAFE_VALUE: "not-needed-by-installer",
      ATALK_AGENT_TOKEN: "activation-secret",
      GITHUB_TOKEN: "github-secret",
      NODE_AUTH_TOKEN: "npm-secret",
      "NPM_CONFIG_//REGISTRY.NPMJS.ORG/:_AUTHTOKEN": "scoped-secret",
      NPM_CONFIG__AUTH: "basic-secret",
      NPM_CONFIG_USERCONFIG: "/secret/npmrc",
      NPM_CONFIG_GLOBALCONFIG: "/secret/global-npmrc",
    });
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.SAFE_VALUE).toBeUndefined();
    expect(environment.ATALK_AGENT_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.NODE_AUTH_TOKEN).toBeUndefined();
    expect(environment["NPM_CONFIG_//REGISTRY.NPMJS.ORG/:_AUTHTOKEN"]).toBeUndefined();
    expect(environment.NPM_CONFIG__AUTH).toBeUndefined();
    expect(environment.NPM_CONFIG_USERCONFIG).not.toBe("/secret/npmrc");
    expect(environment.NPM_CONFIG_GLOBALCONFIG).not.toBe("/secret/global-npmrc");
  });

  it("binds the health gate to the launched PID, version, and agent identity", () => {
    const expectation = {
      integrationName: MANAGED_GATEWAY_PACKAGE,
      integrationVersion: "0.1.0-alpha.15",
      processId: 12_345,
      peerId: "peer-1",
    } as const;
    const response = {
      status: "ok",
      connected: true,
      identity: { id: "peer-1" },
      runtime: {
        processId: 12_345,
        metadata: { integration: { name: MANAGED_GATEWAY_PACKAGE, version: "0.1.0-alpha.15" } },
      },
    };
    expect(parseRuntimeHealthReport(response, expectation)).toEqual({
      peerId: "peer-1",
      integrationVersion: "0.1.0-alpha.15",
      processId: 12_345,
    });
    expect(parseRuntimeHealthReport({ ...response, runtime: { ...response.runtime, processId: 54_321 } }, expectation))
      .toBe(false);
    expect(parseRuntimeHealthReport({
      ...response,
      runtime: {
        ...response.runtime,
        metadata: { integration: { name: MANAGED_GATEWAY_PACKAGE, version: "0.1.0-alpha.14" } },
      },
    }, expectation)).toBe(false);
  });

  it("stages only the fixed official package at the exact advised version", async () => {
    const fixture = await fixtureManager();
    const result = await fixture.manager.update();
    expect(result).toMatchObject({
      changed: true,
      active: { version: "0.1.0-alpha.14" },
      stagedVersion: "0.1.0-alpha.15",
    });
    expect(fixture.resolveArtifact).toHaveBeenCalledWith(MANAGED_GATEWAY_PACKAGE, "0.1.0-alpha.15");
    expect(fixture.installArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.selfTest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(fixture.stateDirectory, "active.json"), "utf8"))).toMatchObject({
      version: "0.1.0-alpha.14",
    });
  });

  it("dry-runs without consulting the registry or creating an active marker", async () => {
    const fixture = await fixtureManager();
    const result = await fixture.manager.update({ dryRun: true });
    expect(result).toMatchObject({
      changed: false,
      active: { version: "0.1.0-alpha.14" },
      decision: { action: "UPDATE" },
    });
    expect(fixture.resolveArtifact).not.toHaveBeenCalled();
    await expect(readFile(join(fixture.stateDirectory, "active.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a manual stage from an advisory older than 24 hours", async () => {
    const fixture = await fixtureManager();
    await writeFile(fixture.updateStatusPath, `${JSON.stringify({
      ...runtimeStatus(),
      advisory: advisory({ checkedAt: "2026-09-01T00:00:00.000Z" }),
    })}\n`, { mode: 0o600 });
    await expect(fixture.manager.update({ dryRun: true })).resolves.toMatchObject({
      changed: false,
      decision: { action: "NONE", reason: expect.stringContaining("stale") },
    });
    expect((await fixture.manager.status()).decision).toMatchObject({
      action: "NONE",
      reason: expect.stringContaining("stale"),
    });
    await expect(fixture.manager.update()).rejects.toThrow("advisory is stale");
    expect(fixture.resolveArtifact).not.toHaveBeenCalled();
  });

  it("recovers a missing old bootstrap with an equal or newer packaged manager", async () => {
    const fixture = await fixtureManager();
    const old = await fixture.manager.initialize();
    await rm(old.entrypoint);
    const replacement = join(directory!, "replacement", "cli.js");
    await mkdir(join(directory!, "replacement"), { recursive: true });
    await writeFile(replacement, "// replacement\n");
    const upgraded = new NodeRuntimeManager({
      stateDirectory: fixture.stateDirectory,
      credentialPath: fixture.credentialPath,
      updateStatusPath: fixture.updateStatusPath,
      bootstrapEntrypoint: replacement,
      bootstrapVersion: "0.1.0-alpha.15",
    });
    await expect(upgraded.initialize()).resolves.toMatchObject({
      version: "0.1.0-alpha.15",
      entrypoint: replacement,
      source: "BOOTSTRAP",
    });
  });

  it("always reconstructs an inactive candidate instead of reusing a staged tree", async () => {
    const fixture = await fixtureManager();
    await fixture.manager.update();
    const entrypoint = join(fixture.stateDirectory, "versions", "0.1.0-alpha.15", "node_modules", "@atalk", "gateway", "dist", "cli.js");
    await fixture.manager.update();
    expect(fixture.installArtifact).toHaveBeenCalledTimes(2);
    expect(await readFile(entrypoint, "utf8")).toBe("// staged\n");
  });

  it("rejects a persisted marker that points to an arbitrary child entrypoint", async () => {
    const fixture = await fixtureManager();
    const arbitraryEntrypoint = join(directory!, "arbitrary.js");
    await writeFile(arbitraryEntrypoint, "// arbitrary\n");
    await mkdir(fixture.stateDirectory, { recursive: true });
    await writeFile(join(fixture.stateDirectory, "active.json"), `${JSON.stringify({
      version: "0.1.0-alpha.15",
      entrypoint: arbitraryEntrypoint,
      activatedAt: "2026-09-04T12:00:00.000Z",
      source: "BOOTSTRAP",
    })}\n`, { mode: 0o600 });

    await expect(fixture.manager.initialize()).rejects.toThrow("would be a downgrade");
    const internals = fixture.manager as unknown as {
      launch(marker: { version: string; entrypoint: string; activatedAt: string; source: "BOOTSTRAP" }): Promise<unknown>;
    };
    await expect(internals.launch({
      version: "0.1.0-alpha.15",
      entrypoint: arbitraryEntrypoint,
      activatedAt: "2026-09-04T12:00:00.000Z",
      source: "BOOTSTRAP",
    })).rejects.toThrow("does not match the packaged Gateway runtime");
  });

  it("retains its validated active runtime when a child rewrites the marker before exiting", async () => {
    const abort = new AbortController();
    const launched: ExitChild[] = [];
    let stateDirectory = "";
    const fixture = await fixtureManager({
      launch: async (entrypoint) => {
        const child = new ExitChild(entrypoint);
        launched.push(child);
        return child;
      },
      healthCheck: async (_url, expectation) => {
        return fakeHealthReport(expectation.processId);
      },
      sleep: async (milliseconds) => {
        if (milliseconds === 2_000) {
          if (launched.length === 1) {
            launched[0]?.exit(1);
            return new Promise<void>(() => undefined);
          }
          abort.abort();
          return;
        }
        if (milliseconds === 1_000) {
          const arbitraryEntrypoint = join(directory!, "exit-injected.js");
          await writeFile(arbitraryEntrypoint, "// injected\n");
          await writeFile(join(stateDirectory, "active.json"), `${JSON.stringify({
            version: "0.1.0-alpha.15",
            entrypoint: arbitraryEntrypoint,
            activatedAt: "2026-09-04T12:00:00.000Z",
            source: "BOOTSTRAP",
          })}\n`, { mode: 0o600 });
        }
      },
    }, { pollIntervalMs: 2_000 });
    stateDirectory = fixture.stateDirectory;

    await expect(fixture.manager.run(abort.signal)).resolves.toBeUndefined();
    expect(launched).toHaveLength(2);
    expect(launched.every((child) => child.entrypoint.includes("bootstrap"))).toBe(true);
    expect(launched[1]?.stopped).toBe(true);
  });

  it("keeps supervising through failed relaunches with escalating backoff", async () => {
    const abort = new AbortController();
    const launched: ExitChild[] = [];
    const restartDelays: number[] = [];
    let launchAttempts = 0;
    let clock = Date.parse("2026-09-04T12:00:00.000Z");
    let reachedHealthyRelaunch!: () => void;
    const healthyRelaunch = new Promise<void>((resolve) => { reachedHealthyRelaunch = resolve; });
    const fixture = await fixtureManager({
      now: () => new Date(clock),
      launch: async (entrypoint) => {
        launchAttempts += 1;
        if (launchAttempts === 2) throw new Error("spawn failed");
        const child = new ExitChild(entrypoint);
        launched.push(child);
        return child;
      },
      healthCheck: async (_url, expectation) => launchAttempts === 3
        ? false
        : fakeHealthReport(expectation.processId),
      sleep: async (milliseconds, signal) => {
        clock += milliseconds;
        if ([1_000, 5_000, 30_000].includes(milliseconds)) restartDelays.push(milliseconds);
        if (milliseconds === 2_000 && launchAttempts === 1) {
          launched[0]?.exit(1);
          return new Promise<void>(() => undefined);
        }
        if (milliseconds === 2_000 && launchAttempts === 4) {
          reachedHealthyRelaunch();
          await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    }, { pollIntervalMs: 2_000, healthTimeoutMs: 1_000 });

    let settled = false;
    const running = fixture.manager.run(abort.signal).finally(() => { settled = true; });
    await healthyRelaunch;
    expect(settled).toBe(false);
    expect(launchAttempts).toBe(4);
    expect(restartDelays).toEqual([1_000, 5_000, 30_000]);
    expect(launched[1]?.stopped).toBe(true);
    expect(launched[2]?.stopped).toBe(false);
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    expect(launched[2]?.stopped).toBe(true);
  });

  it("never forwards the one-time activation token to staged or managed runtimes", async () => {
    const fixture = await fixtureManager({}, {
      childEnvironment: { ATALK_AGENT_TOKEN: "one-time-secret", SAFE_VALUE: "kept" },
    });
    await fixture.manager.update();
    const environment = fixture.selfTest.mock.calls[0]?.[1];
    expect(environment?.ATALK_AGENT_TOKEN).toBeUndefined();
    expect(environment?.SAFE_VALUE).toBeUndefined();
    expect(environment?.ATALK_CREDENTIAL_PATH).toBeUndefined();
  });

  it("locks concurrent update attempts", async () => {
    let releaseInstall!: () => void;
    let installStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { installStarted = resolveStarted; });
    const blocked = new Promise<void>((resolveInstall) => { releaseInstall = resolveInstall; });
    const fixture = await fixtureManager({
      installArtifact: async (artifact, stage) => {
        installStarted();
        await blocked;
        await fakeInstall(artifact, stage);
      },
    });
    const first = fixture.manager.update();
    await started;
    await expect(fixture.manager.update()).rejects.toThrow("already in progress");
    releaseInstall();
    await expect(first).resolves.toMatchObject({ changed: true });
  });

  it("backs staging failures off persistently per exact version", async () => {
    const resolveArtifact = vi.fn(async () => { throw new Error("registry unavailable"); });
    const fixture = await fixtureManager({ resolveArtifact });
    const active = await fixture.manager.initialize();
    const child = new FakeChild(active.entrypoint);
    const launchId = "55555555-5555-4555-8555-555555555555";
    Object.defineProperty(child, "launchId", { value: launchId, enumerable: true });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(child.pid, launchId))}\n`, { mode: 0o600 });
    const internals = fixture.manager as unknown as {
      updateRunning(runtime: ManagedRuntimeChild, active: typeof active): Promise<{ result: { decision: { action: string } } }>;
    };

    await expect(internals.updateRunning(child, active)).rejects.toThrow("registry unavailable");
    await expect(internals.updateRunning(child, active)).resolves.toMatchObject({
      result: { decision: { action: "NOTIFY", reason: expect.stringContaining("next automatic retry") } },
    });
    expect(resolveArtifact).toHaveBeenCalledTimes(1);
    expect((await fixture.manager.status()).stagingRetry).toMatchObject({
      candidateVersion: "0.1.0-alpha.15",
      attempts: 1,
    });

    await writeFile(fixture.updateStatusPath, `${JSON.stringify({
      ...runtimeStatus(child.pid, launchId),
      advisory: advisory({ recommendedVersion: "0.1.0-alpha.16" }),
    })}\n`, { mode: 0o600 });
    await expect(internals.updateRunning(child, active)).rejects.toThrow("registry unavailable");
    expect(resolveArtifact).toHaveBeenCalledTimes(2);
  });

  it("treats a reused PID with an old launch id as display-only", async () => {
    const fixture = await fixtureManager();
    const active = await fixture.manager.initialize();
    const child = new FakeChild(active.entrypoint);
    Object.defineProperty(child, "launchId", {
      value: "66666666-6666-4666-8666-666666666666",
      enumerable: true,
    });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(
      child.pid,
      "77777777-7777-4777-8777-777777777777",
    ))}\n`, { mode: 0o600 });
    const internals = fixture.manager as unknown as {
      updateRunning(runtime: ManagedRuntimeChild, active: typeof active): Promise<{ result: { decision: { action: string } } }>;
    };
    await expect(internals.updateRunning(child, active)).resolves.toMatchObject({
      result: { decision: { action: "NONE", reason: expect.stringContaining("fresh advisory") } },
    });
    expect(fixture.resolveArtifact).not.toHaveBeenCalled();
  });

  it("treats stale or far-future launch-bound advisories as display-only", async () => {
    const fixture = await fixtureManager();
    const active = await fixture.manager.initialize();
    const child = new FakeChild(active.entrypoint);
    Object.defineProperty(child, "launchId", {
      value: "99999999-9999-4999-8999-999999999999",
      enumerable: true,
    });
    const internals = fixture.manager as unknown as {
      updateRunning(runtime: ManagedRuntimeChild, active: typeof active): Promise<{ result: { decision: { action: string } } }>;
    };
    for (const checkedAt of ["2026-09-03T00:00:00.000Z", "2026-09-04T13:00:00.000Z"]) {
      await writeFile(fixture.updateStatusPath, `${JSON.stringify({
        ...runtimeStatus(child.pid, child.launchId),
        advisory: advisory({ checkedAt }),
      })}\n`, { mode: 0o600 });
      await expect(internals.updateRunning(child, active)).resolves.toMatchObject({
        result: { decision: { action: "NONE", reason: expect.stringContaining("fresh advisory") } },
      });
    }
    expect(fixture.resolveArtifact).not.toHaveBeenCalled();
  });

  it("ignores a manual approval timestamp too far in the future", async () => {
    const fixture = await fixtureManager();
    await mkdir(fixture.stateDirectory, { recursive: true });
    await writeFile(join(fixture.stateDirectory, "manual-approval.json"), `${JSON.stringify({
      version: 1,
      candidateVersion: "0.1.0-alpha.15",
      approvedAt: "2026-09-04T13:00:00.000Z",
    })}\n`, { mode: 0o600 });
    expect((await fixture.manager.status()).manualApproval).toBeNull();
  });

  it("turns a NOTIFY advisory into one exact supervised attempt only after explicit update", async () => {
    const abort = new AbortController();
    const launched: FakeChild[] = [];
    let updateStatusPath = "";
    const fixture = await fixtureManager({
      launch: async (entrypoint, _args, environment) => {
        const child = new FakeChild(entrypoint);
        launched.push(child);
        const version = entrypoint.includes("0.1.0-alpha.15") ? "0.1.0-alpha.15" : "0.1.0-alpha.14";
        await writeFile(updateStatusPath, `${JSON.stringify(runtimeStatus(
          child.pid,
          environment.ATALK_RUNTIME_LAUNCH_ID,
          version,
        ))}\n`, { mode: 0o600 });
        return child;
      },
      healthCheck: async (_url, expectation) => fakeHealthReport(expectation.processId),
      sleep: async (milliseconds) => { if (milliseconds === 1_000) abort.abort(); },
    }, { localPolicy: "NOTIFY" });
    updateStatusPath = fixture.updateStatusPath;

    expect((await fixture.manager.status()).decision.action).toBe("NOTIFY");
    const staged = await fixture.manager.update();
    expect(staged).toMatchObject({
      changed: true,
      stagedVersion: "0.1.0-alpha.15",
      approvedVersion: "0.1.0-alpha.15",
      active: { version: "0.1.0-alpha.14" },
    });
    expect((await fixture.manager.status()).manualApproval).toMatchObject({ candidateVersion: "0.1.0-alpha.15" });

    await fixture.manager.run(abort.signal);
    expect(launched).toHaveLength(2);
    expect(fixture.installArtifact).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(join(fixture.stateDirectory, "active.json"), "utf8"))).toMatchObject({
      version: "0.1.0-alpha.15",
    });
    expect((await fixture.manager.status()).manualApproval).toBeNull();
  });

  it("rolls an unhealthy candidate back and leaves the restored child running", async () => {
    const launched: FakeChild[] = [];
    let clock = Date.parse("2026-09-04T12:00:00.000Z");
    let candidateHealthCalls = 0;
    const fixture = await fixtureManager({
      now: () => new Date(clock += 600),
      launch: async (entrypoint) => {
        const child = new FakeChild(entrypoint);
        launched.push(child);
        return child;
      },
      healthCheck: async () => {
        const current = launched.at(-1);
        if (current?.entrypoint.includes("0.1.0-alpha.15")) {
          candidateHealthCalls += 1;
          return false;
        }
        return fakeHealthReport(current?.pid);
      },
    }, { healthTimeoutMs: 1_000 });
    const active = await fixture.manager.initialize();
    const original = new FakeChild(active.entrypoint);
    const originalLaunchId = "44444444-4444-4444-8444-444444444444";
    Object.defineProperty(original, "launchId", { value: originalLaunchId, enumerable: true });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(original.pid, originalLaunchId))}\n`, { mode: 0o600 });
    const internals = fixture.manager as unknown as {
      updateRunning(child: ManagedRuntimeChild, active: typeof active): Promise<{
        result: { rolledBack?: boolean; active: { version: string } | null };
        child: ManagedRuntimeChild;
      }>;
    };
    const transition = await internals.updateRunning(original, active);

    expect(candidateHealthCalls).toBeGreaterThan(0);
    expect(original.stopped).toBe(true);
    expect(launched).toHaveLength(2);
    expect(launched[0]?.stopped).toBe(true);
    expect(launched[1]?.stopped).toBe(false);
    expect(transition.child).toBe(launched[1]);
    expect(transition.result).toMatchObject({ rolledBack: true, active: { version: "0.1.0-alpha.14" } });
    expect(JSON.parse(await readFile(join(fixture.stateDirectory, "active.json"), "utf8"))).toMatchObject({
      version: "0.1.0-alpha.14",
    });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(
      transition.child.pid,
      transition.child.launchId,
    ))}\n`, { mode: 0o600 });
    const repeated = await internals.updateRunning(transition.child, active);
    expect(repeated.result).toMatchObject({ changed: false, decision: { action: "NOTIFY" } });
    expect(repeated.child).toBe(transition.child);
    expect(launched).toHaveLength(2);
    expect((await fixture.manager.status()).quarantinedCandidate).toMatchObject({
      candidateVersion: "0.1.0-alpha.15",
    });

    const manualRetry = await fixture.manager.update();
    expect(manualRetry).toMatchObject({ changed: true, stagedVersion: "0.1.0-alpha.15" });
    expect(fixture.installArtifact).toHaveBeenCalledTimes(2);
    expect((await fixture.manager.status()).quarantinedCandidate).toBeNull();
  });

  it("rolls back a healthy-looking candidate that never publishes its own launch-bound sidecar", async () => {
    const launched: FakeChild[] = [];
    const fixture = await fixtureManager({
      launch: async (entrypoint) => {
        const child = new FakeChild(entrypoint);
        launched.push(child);
        return child;
      },
      healthCheck: async (_url, expectation) => fakeHealthReport(expectation.processId),
    }, { healthTimeoutMs: 1_000 });
    const active = await fixture.manager.initialize();
    const original = new FakeChild(active.entrypoint);
    Object.defineProperty(original, "launchId", {
      value: "88888888-8888-4888-8888-888888888888",
      enumerable: true,
    });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(original.pid, original.launchId))}\n`, { mode: 0o600 });
    const internals = fixture.manager as unknown as {
      updateRunning(child: ManagedRuntimeChild, active: typeof active): Promise<{
        result: { rolledBack?: boolean; active: { version: string } | null };
        child: ManagedRuntimeChild;
      }>;
    };

    const transition = await internals.updateRunning(original, active);

    expect(transition.result).toMatchObject({ rolledBack: true, active: { version: "0.1.0-alpha.14" } });
    expect(launched).toHaveLength(2);
    expect(launched[0]?.stopped).toBe(true);
    expect(launched[1]?.stopped).toBe(false);
    expect(transition.child).toBe(launched[1]);
  });

  it("quarantines a failed candidate even when the first rollback launch also fails", async () => {
    let clock = Date.parse("2026-09-04T12:00:00.000Z");
    let launchAttempts = 0;
    const launched: FakeChild[] = [];
    const fixture = await fixtureManager({
      now: () => new Date(clock += 600),
      launch: async (entrypoint) => {
        launchAttempts += 1;
        if (launchAttempts === 2) throw new Error("rollback spawn failed");
        const child = new FakeChild(entrypoint);
        launched.push(child);
        return child;
      },
      healthCheck: async () => false,
    }, { healthTimeoutMs: 1_000 });
    const active = await fixture.manager.initialize();
    const original = new FakeChild(active.entrypoint);
    Object.defineProperty(original, "launchId", {
      value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      enumerable: true,
    });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(original.pid, original.launchId))}\n`, { mode: 0o600 });
    const internals = fixture.manager as unknown as {
      updateRunning(child: ManagedRuntimeChild, active: typeof active): Promise<{
        result: { decision: { action: string } };
        child: ManagedRuntimeChild;
      }>;
    };

    await expect(internals.updateRunning(original, active)).rejects.toThrow(
      "Candidate was quarantined and the previous runtime could not be restored",
    );
    expect((await fixture.manager.status()).quarantinedCandidate).toMatchObject({
      candidateVersion: "0.1.0-alpha.15",
      reason: expect.stringContaining("failed health checks"),
    });

    const recovered = new FakeChild(active.entrypoint);
    Object.defineProperty(recovered, "launchId", {
      value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      enumerable: true,
    });
    await writeFile(fixture.updateStatusPath, `${JSON.stringify(runtimeStatus(recovered.pid, recovered.launchId))}\n`, { mode: 0o600 });
    await expect(internals.updateRunning(recovered, active)).resolves.toMatchObject({
      result: { decision: { action: "NOTIFY", reason: expect.stringContaining("quarantined") } },
      child: recovered,
    });
    expect(launchAttempts).toBe(2);
  });

  it("reclaims a heartbeat lock only after the lock implementation marks it stale", async () => {
    const fixture = await fixtureManager();
    await mkdir(fixture.stateDirectory, { recursive: true });
    const lockDirectory = join(fixture.stateDirectory, "update.lock.lock");
    await mkdir(lockDirectory);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, stale, stale);
    await expect(fixture.manager.update()).resolves.toMatchObject({ changed: true });
  });

  it("reclaims a stale supervisor heartbeat lease after a crash", async () => {
    const abort = new AbortController();
    const fixture = await fixtureManager({
      healthCheck: async (_url, expectation) => fakeHealthReport(expectation.processId),
      sleep: async (milliseconds) => { if (milliseconds === 1_000) abort.abort(); },
    });
    await mkdir(fixture.stateDirectory, { recursive: true });
    const lockDirectory = join(fixture.stateDirectory, "supervisor.lock.lock");
    await mkdir(lockDirectory);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, stale, stale);
    await expect(fixture.manager.run(abort.signal)).resolves.toBeUndefined();
    expect((await fixture.manager.status()).supervisorActive).toBe(false);
  });

  it("refuses unsafe persisted credential files before launching a child", async () => {
    if (process.platform === "win32") return;
    const fixture = await fixtureManager();
    await chmod(fixture.credentialPath, 0o644);
    await expect(fixture.manager.run()).rejects.toThrow("chmod 600");

    await rm(fixture.credentialPath);
    const target = join(directory!, "credentials", "real.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await symlink(target, fixture.credentialPath);
    await expect(fixture.manager.run()).rejects.toThrow("symbolic link");
  });

  it("runs as the real parent, keeps the healthy candidate, and stops it on shutdown", async () => {
    const abort = new AbortController();
    const launched: FakeChild[] = [];
    const launchedEnvironments: NodeJS.ProcessEnv[] = [];
    vi.stubEnv("NODE_AUTH_TOKEN", "implicit-npm-secret");
    vi.stubEnv("GITHUB_TOKEN", "implicit-github-secret");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "implicit-cloud-secret");
    let updateStatusPath = "";
    const fixture = await fixtureManager({
      launch: async (entrypoint, _args, environment) => {
        const child = new FakeChild(entrypoint);
        launched.push(child);
        launchedEnvironments.push(environment);
        const version = entrypoint.includes("0.1.0-alpha.15") ? "0.1.0-alpha.15" : "0.1.0-alpha.14";
        await writeFile(updateStatusPath, `${JSON.stringify(runtimeStatus(
          child.pid,
          environment.ATALK_RUNTIME_LAUNCH_ID,
          version,
        ))}\n`, { mode: 0o600 });
        return child;
      },
      healthCheck: async (_url, expectation) => fakeHealthReport(expectation.processId),
      sleep: async (milliseconds) => { if (milliseconds === 1_000) abort.abort(); },
    }, {
      childEnvironment: { ATALK_AGENT_TOKEN: "one-time-secret", SAFE_VALUE: "kept" },
    });
    updateStatusPath = fixture.updateStatusPath;

    await fixture.manager.run(abort.signal);

    expect(launched).toHaveLength(2);
    expect(launched[0]?.entrypoint).toContain("bootstrap");
    expect(launched[0]?.stopped).toBe(true);
    expect(launched[1]?.entrypoint).toContain("0.1.0-alpha.15");
    expect(launched[1]?.stopped).toBe(true);
    expect(launchedEnvironments).toHaveLength(2);
    expect(launchedEnvironments.every((environment) => environment.ATALK_AGENT_TOKEN === undefined)).toBe(true);
    expect(launchedEnvironments.every((environment) => environment.SAFE_VALUE === "kept")).toBe(true);
    expect(launchedEnvironments.every((environment) => environment.NODE_AUTH_TOKEN === undefined)).toBe(true);
    expect(launchedEnvironments.every((environment) => environment.GITHUB_TOKEN === undefined)).toBe(true);
    expect(launchedEnvironments.every((environment) => environment.AWS_SECRET_ACCESS_KEY === undefined)).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.stateDirectory, "active.json"), "utf8"))).toMatchObject({
      version: "0.1.0-alpha.15",
    });
  });

  async function fixtureManager(
    overrides: Partial<RuntimeManagerDependencies> = {},
    managerOverrides: Partial<ConstructorParameters<typeof NodeRuntimeManager>[0]> = {},
  ) {
    directory = await mkdtemp(join(tmpdir(), "atalk-runtime-manager-"));
    const stateDirectory = join(directory, "state");
    const credentialPath = join(directory, "credentials", "agent.json");
    const updateStatusPath = `${credentialPath}.update.json`;
    const bootstrapEntrypoint = join(directory, "bootstrap", "cli.js");
    await mkdir(join(directory, "bootstrap"), { recursive: true });
    await mkdir(join(directory, "credentials"), { recursive: true });
    await writeFile(bootstrapEntrypoint, "// bootstrap\n");
    await writeFile(credentialPath, "{}\n", { mode: 0o600 });
    await writeFile(updateStatusPath, `${JSON.stringify(runtimeStatus())}\n`, { mode: 0o600 });
    const resolveArtifact = vi.fn(overrides.resolveArtifact
      ?? (async (_name, version): Promise<NpmRuntimeArtifact> => artifactFixture(version)));
    const installArtifact = vi.fn(overrides.installArtifact ?? fakeInstall);
    const selfTest = vi.fn(overrides.selfTest ?? (async () => undefined));
    const manager = new NodeRuntimeManager({
      stateDirectory,
      credentialPath,
      updateStatusPath,
      bootstrapEntrypoint,
      bootstrapVersion: "0.1.0-alpha.14",
      localPolicy: "COMPATIBLE",
      pollIntervalMs: 1_000,
      dependencies: {
        resolveArtifact,
        installArtifact,
        selfTest,
        launch: overrides.launch ?? (async (entrypoint) => new FakeChild(entrypoint)),
        healthCheck: overrides.healthCheck ?? (async (_url, expectation) => fakeHealthReport(expectation.processId)),
        ...(overrides.isProcessAlive ? { isProcessAlive: overrides.isProcessAlive } : {}),
        now: overrides.now ?? (() => new Date("2026-09-04T12:00:00.000Z")),
        sleep: overrides.sleep ?? (async () => undefined),
      },
      ...managerOverrides,
    });
    return {
      manager,
      stateDirectory,
      credentialPath,
      updateStatusPath,
      resolveArtifact,
      installArtifact,
      selfTest,
    };
  }
});

class FakeChild implements ManagedRuntimeChild {
  private static nextPid = 10_000;
  readonly pid = FakeChild.nextPid++;
  stopped = false;
  readonly exited = new Promise<number | null>(() => undefined);
  constructor(readonly entrypoint: string) {}
  async stop(): Promise<void> { this.stopped = true; }
}

class ExitChild implements ManagedRuntimeChild {
  private static nextPid = 20_000;
  readonly pid = ExitChild.nextPid++;
  stopped = false;
  private resolveExit!: (code: number | null) => void;
  readonly exited = new Promise<number | null>((resolve) => { this.resolveExit = resolve; });
  constructor(readonly entrypoint: string) {}
  exit(code: number | null): void { this.resolveExit(code); }
  async stop(): Promise<void> { this.stopped = true; }
}

function artifactFixture(version: string): NpmRuntimeArtifact {
  const integrity = `sha512-${createHash("sha512").update(`@atalk/gateway@${version}`).digest("base64")}`;
  return {
    packageName: MANAGED_GATEWAY_PACKAGE,
    version,
    tarballUrl: `https://registry.npmjs.org/fake/${version}.tgz`,
    integrity,
    shasum: "0123456789abcdef0123456789abcdef01234567",
    provenanceUrl: `https://registry.npmjs.org/-/npm/v1/attestations/@atalk%2fgateway@${version}`,
  };
}

function fakeHealthReport(processId = 1) {
  return { peerId: "peer-1", integrationVersion: "0.1.0-alpha.14", processId };
}

async function fakeInstall(artifact: NpmRuntimeArtifact, stageDirectory: string): Promise<void> {
  const packageDirectory = join(stageDirectory, "node_modules", "@atalk", "gateway");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: artifact.packageName, version: artifact.version }));
  await writeFile(join(packageDirectory, "runtime-dependency-lock.json"), JSON.stringify({
    version: 1,
    root: { name: artifact.packageName, version: artifact.version },
    packages: { [artifact.packageName]: artifact.version },
    required: [artifact.packageName],
  }));
  await writeFile(join(packageDirectory, "dist", "cli.js"), "// staged\n");
}

function advisory(overrides: Partial<RuntimeUpdateAdvisory> = {}): RuntimeUpdateAdvisory {
  return {
    status: "UPDATE_AVAILABLE",
    currentVersion: "0.1.0-alpha.14",
    recommendedVersion: "0.1.0-alpha.15",
    severity: "INFO",
    policy: "COMPATIBLE",
    checkedAt: "2026-09-04T12:00:00.000Z",
    ...overrides,
  };
}

function runtimeStatus(
  writerProcessId?: number,
  writerLaunchId?: string,
  integrationVersion = "0.1.0-alpha.14",
): PersistedRuntimeUpdateStatus {
  return {
    version: 1,
    ...(writerProcessId ? { writerProcessId } : {}),
    ...(writerLaunchId ? { writerLaunchId } : {}),
    metadata: {
      sdk: { name: "@atalk/sdk", version: "0.1.0-alpha.14" },
      integration: { name: MANAGED_GATEWAY_PACKAGE, version: integrationVersion },
      protocolVersion: 1,
      channel: "PREVIEW",
      capabilities: ["gateway.http", "runtime.auto-update"],
    },
    advisory: advisory({ currentVersion: integrationVersion }),
  };
}

function officialProvenanceBundle(artifact: NpmRuntimeArtifact) {
  const sha512 = Buffer.from(/^sha512-([^?]+)/u.exec(artifact.integrity)![1]!, "base64").toString("hex");
  const tag = `refs/tags/node-v${artifact.version}`;
  return {
    predicateType: "https://slsa.dev/provenance/v1",
    bundle: {
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify({
          _type: "https://in-toto.io/Statement/v1",
          subject: [{ name: `pkg:npm/%40atalk/gateway@${artifact.version}`, digest: { sha512 } }],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
              externalParameters: {
                workflow: {
                  ref: tag,
                  repository: "https://github.com/atalk-network/atalk-developers",
                  path: ".github/workflows/release-node.yml",
                },
              },
              resolvedDependencies: [{
                uri: `git+https://github.com/atalk-network/atalk-developers@${tag}`,
                digest: { gitCommit: "0123456789abcdef0123456789abcdef01234567" },
              }],
            },
          },
        })).toString("base64"),
      },
    },
  };
}

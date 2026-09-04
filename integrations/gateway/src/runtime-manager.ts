import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  ATALK_SDK_VERSION,
  parseRuntimeUpdateAdvisory,
  type AgentRuntimeCheckIn,
  type PersistedRuntimeUpdateStatus,
  type RuntimeUpdateAdvisory,
  type RuntimeUpdatePolicy,
} from "@atalk/sdk";
import lockfile from "proper-lockfile";

export const MANAGED_GATEWAY_PACKAGE = "@atalk/gateway" as const;

export interface RuntimeManagerPaths {
  stateDirectory: string;
  credentialPath: string;
  updateStatusPath: string;
}

export interface NpmRuntimeArtifact {
  packageName: typeof MANAGED_GATEWAY_PACKAGE;
  version: string;
  tarballUrl: string;
  integrity: string;
  shasum: string;
  provenanceUrl: string;
}

export interface ManagedRuntimeChild {
  readonly pid?: number;
  readonly launchId?: string;
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface RuntimeHealthExpectation {
  integrationName: typeof MANAGED_GATEWAY_PACKAGE;
  integrationVersion: string;
  processId?: number;
  peerId?: string;
}

export interface RuntimeHealthReport {
  peerId: string;
  integrationVersion: string;
  processId: number;
}

export interface RuntimeManagerDependencies {
  resolveArtifact(packageName: typeof MANAGED_GATEWAY_PACKAGE, version: string): Promise<NpmRuntimeArtifact>;
  installArtifact(artifact: NpmRuntimeArtifact, stageDirectory: string): Promise<void>;
  selfTest(entrypoint: string, environment: NodeJS.ProcessEnv): Promise<void>;
  launch(entrypoint: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<ManagedRuntimeChild>;
  healthCheck(
    url: string,
    expectation: RuntimeHealthExpectation,
    apiKey?: string,
  ): Promise<RuntimeHealthReport | false>;
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface NodeRuntimeManagerOptions {
  stateDirectory?: string;
  credentialPath?: string;
  updateStatusPath?: string;
  localPolicy?: RuntimeUpdatePolicy;
  pollIntervalMs?: number;
  healthTimeoutMs?: number;
  gatewayHost?: string;
  gatewayPort?: number;
  gatewayApiKey?: string;
  childArgs?: readonly string[];
  childEnvironment?: NodeJS.ProcessEnv;
  /** Current packaged CLI used to bootstrap the first active marker. */
  bootstrapEntrypoint: string;
  bootstrapVersion?: string;
  dependencies?: Partial<RuntimeManagerDependencies>;
}

export interface RuntimeUpdateDecision {
  action: "NONE" | "NOTIFY" | "UPDATE";
  reason: string;
  candidateVersion?: string;
  effectivePolicy: RuntimeUpdatePolicy;
}

export interface ActiveRuntimeMarker {
  version: string;
  entrypoint: string;
  activatedAt: string;
  source: "BOOTSTRAP" | "VERIFIED";
}

export interface RuntimeManagerSnapshot {
  active: ActiveRuntimeMarker | null;
  status: PersistedRuntimeUpdateStatus | null;
  decision: RuntimeUpdateDecision;
  quarantinedCandidate: RuntimeCandidateQuarantine | null;
  stagingRetry: RuntimeStagingRetry | null;
  manualApproval: RuntimeManualApproval | null;
  updateInProgress: boolean;
  supervisorActive: boolean;
}

export interface RuntimeCandidateQuarantine {
  version: 1;
  candidateVersion: string;
  advisoryCheckedAt: string;
  failedAt: string;
  reason: string;
}

export interface RuntimeStagingRetry {
  version: 1;
  candidateVersion: string;
  attempts: number;
  failedAt: string;
  nextRetryAt: string;
  reason: string;
}

export interface RuntimeManualApproval {
  version: 1;
  candidateVersion: string;
  approvedAt: string;
}

interface RuntimeVerificationReceipt {
  version: 1;
  packageName: typeof MANAGED_GATEWAY_PACKAGE;
  packageVersion: string;
  tarballUrl: string;
  integrity: string;
  shasum: string;
  provenanceUrl: string;
  dependencyLockDigest: string;
  treeDigest: string;
  verifiedAt: string;
}

export interface RuntimeDependencyLock {
  version: 1;
  root: { name: typeof MANAGED_GATEWAY_PACKAGE; version: string };
  packages: Record<string, string>;
  required: string[];
}

interface ManagedLock {
  nonce: string;
  release(): Promise<void>;
}

export interface RuntimeUpdateResult {
  decision: RuntimeUpdateDecision;
  changed: boolean;
  active: ActiveRuntimeMarker | null;
  rolledBack?: boolean;
  error?: string;
  stagedVersion?: string;
  approvedVersion?: string;
}

const POLICY_RANK: Record<RuntimeUpdatePolicy, number> = { NOTIFY: 0, SECURITY: 1, COMPATIBLE: 2 };
const MANAGER_VERSION = 1;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_RUNTIME_DEPENDENCY_LOCK_BYTES = 64 * 1024;
const MAX_ATTESTATION_PAYLOAD_BYTES = 512 * 1024;
const MAX_REGISTRY_METADATA_BYTES = 1024 * 1024;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const REGISTRY_METADATA_TIMEOUT_MS = 15_000;
const REGISTRY_DOWNLOAD_TIMEOUT_MS = 60_000;
const STAGING_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;
const LOCK_STALE_MS = 30_000;
const LOCK_UPDATE_MS = 10_000;
const RUNTIME_RECEIPT_NAME = ".atalk-runtime-receipt.json";
const RUNTIME_DEPENDENCY_LOCK_NAME = "runtime-dependency-lock.json";
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const HEALTH_PROBATION_CHECKS = 3;
const HEALTH_PROBATION_INTERVAL_MS = 3_000;
const CHILD_RESTART_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000] as const;
const MANUAL_ADVISORY_MAX_AGE_MS = 24 * 60 * 60_000;
const MANUAL_APPROVAL_MAX_AGE_MS = 24 * 60 * 60_000;
const ACTIONABLE_ADVISORY_MAX_AGE_MS = 12 * 60 * 60_000;
const TIMESTAMP_FUTURE_SKEW_MS = 5 * 60_000;

export function defaultRuntimeManagerPaths(credentialPath?: string): RuntimeManagerPaths {
  const credentials = resolve(credentialPath ?? join(homedir(), ".atalk", "gateway-agent.json"));
  const instanceId = createHash("sha256").update(credentials).digest("hex").slice(0, 16);
  return {
    stateDirectory: resolve(join(homedir(), ".atalk", "runtime-manager", "gateway", instanceId)),
    credentialPath: credentials,
    updateStatusPath: `${credentials}.update.json`,
  };
}

export function decideRuntimeUpdate(
  advisory: RuntimeUpdateAdvisory | undefined,
  activeVersion: string | undefined,
  localPolicy: RuntimeUpdatePolicy,
): RuntimeUpdateDecision {
  const effectivePolicy = advisory
    ? policyAtMost(localPolicy, advisory.policy)
    : "NOTIFY";
  if (!advisory) return { action: "NONE", reason: "No signed-in runtime advisory is available", effectivePolicy };
  if (activeVersion && advisory.currentVersion !== activeVersion) {
    return { action: "NONE", reason: "The advisory baseline does not match the active runtime version", effectivePolicy };
  }
  if (advisory.status === "CURRENT" || advisory.status === "UNKNOWN") {
    return { action: "NONE", reason: `Runtime status is ${advisory.status}`, effectivePolicy };
  }
  const candidate = advisory.recommendedVersion;
  if (!candidate || !parseSemver(candidate)) {
    return { action: "NOTIFY", reason: "The advisory has no valid exact npm version", effectivePolicy };
  }
  if (activeVersion && compareSemver(candidate, activeVersion) <= 0) {
    return { action: "NONE", reason: "The recommended version is not newer than the active runtime", effectivePolicy };
  }
  if (effectivePolicy === "NOTIFY") {
    return { action: "NOTIFY", reason: "Policy requires operator approval", candidateVersion: candidate, effectivePolicy };
  }
  if (effectivePolicy === "SECURITY" && advisory.severity !== "SECURITY") {
    return { action: "NOTIFY", reason: "Only security updates are automatic under SECURITY policy", candidateVersion: candidate, effectivePolicy };
  }
  if (effectivePolicy === "COMPATIBLE" && activeVersion && !isCompatibleUpgrade(activeVersion, candidate)) {
    return { action: "NOTIFY", reason: "The candidate is outside the active compatibility line", candidateVersion: candidate, effectivePolicy };
  }
  return { action: "UPDATE", reason: "The advisory and local policy permit a verified update", candidateVersion: candidate, effectivePolicy };
}

function applyCandidateQuarantine(
  decision: RuntimeUpdateDecision,
  quarantine: RuntimeCandidateQuarantine | null,
): RuntimeUpdateDecision {
  if (decision.action !== "UPDATE" || !decision.candidateVersion
    || quarantine?.candidateVersion !== decision.candidateVersion) return decision;
  return {
    ...decision,
    action: "NOTIFY",
    reason: `Candidate ${decision.candidateVersion} is quarantined after a failed health check; run manager update while the supervisor is stopped to restage and retry it`,
  };
}

function applyStagingBackoff(
  decision: RuntimeUpdateDecision,
  retry: RuntimeStagingRetry | null,
  now: Date,
): RuntimeUpdateDecision {
  if (decision.action !== "UPDATE" || !decision.candidateVersion
    || retry?.candidateVersion !== decision.candidateVersion
    || Date.parse(retry.nextRetryAt) <= now.getTime()) return decision;
  return {
    ...decision,
    action: "NOTIFY",
    reason: `Staging ${decision.candidateVersion} is paused after ${retry.attempts} failed attempt${retry.attempts === 1 ? "" : "s"}; next automatic retry ${retry.nextRetryAt}`,
  };
}

function applyManualApproval(
  decision: RuntimeUpdateDecision,
  approval: RuntimeManualApproval | null,
): RuntimeUpdateDecision {
  if (decision.action !== "NOTIFY" || !decision.candidateVersion
    || approval?.candidateVersion !== decision.candidateVersion) return decision;
  return {
    ...decision,
    action: "UPDATE",
    reason: `Exact version ${decision.candidateVersion} has one-shot local operator approval`,
  };
}

function timestampWithinWindow(value: string, now: Date, maximumAgeMs: number): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const age = now.getTime() - timestamp;
  return age >= -TIMESTAMP_FUTURE_SKEW_MS && age <= maximumAgeMs;
}

function staleAdvisoryDecision(policy: RuntimeUpdatePolicy): RuntimeUpdateDecision {
  return {
    action: "NONE",
    reason: "The runtime advisory is stale or too far in the future; obtain a fresh signed-in check-in",
    effectivePolicy: policy,
  };
}

function runtimeStatusFromChild(
  status: PersistedRuntimeUpdateStatus | null,
  child: ManagedRuntimeChild,
  active: ActiveRuntimeMarker,
  now: Date,
): boolean {
  return child.pid !== undefined
    && child.launchId !== undefined
    && status?.writerProcessId === child.pid
    && status.writerLaunchId === child.launchId
    && status.metadata.integration.name === MANAGED_GATEWAY_PACKAGE
    && status.metadata.integration.version === active.version
    && status.advisory.currentVersion === active.version
    && timestampWithinWindow(status.advisory.checkedAt, now, ACTIONABLE_ADVISORY_MAX_AGE_MS);
}

/**
 * External supervisor for an official gateway process. It never accepts code,
 * commands or package names from the server: only an exact version is used to
 * resolve the locally pinned official package from npm.
 */
export class NodeRuntimeManager {
  readonly paths: RuntimeManagerPaths;
  readonly localPolicy: RuntimeUpdatePolicy;
  private readonly markerPath: string;
  private readonly versionsDirectory: string;
  private readonly lockPath: string;
  private readonly supervisorLockPath: string;
  private readonly quarantinePath: string;
  private readonly stagingRetryPath: string;
  private readonly manualApprovalPath: string;
  private readonly pollIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly gatewayHost: string;
  private readonly gatewayPort: number;
  private readonly gatewayApiKey: string | undefined;
  private readonly childArgs: readonly string[];
  private readonly childEnvironment: NodeJS.ProcessEnv;
  private readonly bootstrapEntrypoint: string;
  private readonly bootstrapVersion: string;
  private readonly dependencies: RuntimeManagerDependencies;
  private volatileQuarantine: RuntimeCandidateQuarantine | undefined;
  private volatileStagingRetry: RuntimeStagingRetry | undefined;
  private supervisorNonce: string | undefined;

  constructor(options: NodeRuntimeManagerOptions) {
    const defaults = defaultRuntimeManagerPaths(options.credentialPath);
    this.paths = {
      stateDirectory: resolve(options.stateDirectory ?? defaults.stateDirectory),
      credentialPath: resolve(options.credentialPath ?? defaults.credentialPath),
      updateStatusPath: resolve(options.updateStatusPath ?? `${resolve(options.credentialPath ?? defaults.credentialPath)}.update.json`),
    };
    const localPolicy = options.localPolicy ?? "COMPATIBLE";
    if (POLICY_RANK[localPolicy] === undefined) {
      throw new Error("localPolicy must be NOTIFY, SECURITY, or COMPATIBLE");
    }
    this.localPolicy = localPolicy;
    this.markerPath = join(this.paths.stateDirectory, "active.json");
    this.versionsDirectory = join(this.paths.stateDirectory, "versions");
    this.lockPath = join(this.paths.stateDirectory, "update.lock");
    this.supervisorLockPath = join(this.paths.stateDirectory, "supervisor.lock");
    this.quarantinePath = join(this.paths.stateDirectory, "quarantine.json");
    this.stagingRetryPath = join(this.paths.stateDirectory, "staging-retry.json");
    this.manualApprovalPath = join(this.paths.stateDirectory, "manual-approval.json");
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs ?? 60_000, 1_000, 24 * 60 * 60_000, "pollIntervalMs");
    this.healthTimeoutMs = boundedInteger(options.healthTimeoutMs ?? 30_000, 1_000, 5 * 60_000, "healthTimeoutMs");
    this.gatewayHost = options.gatewayHost ?? "127.0.0.1";
    this.gatewayPort = boundedInteger(options.gatewayPort ?? 8788, 1, 65_535, "gatewayPort");
    this.gatewayApiKey = options.gatewayApiKey;
    this.childArgs = options.childArgs ?? ["start"];
    // Do not implicitly forward the invoking shell (registry, cloud, CI and
    // developer tokens) into an automatically staged runtime. Callers must
    // explicitly opt functional settings in through childEnvironment.
    this.childEnvironment = { ...processExecutionEnvironment(), ...options.childEnvironment };
    this.bootstrapEntrypoint = resolve(options.bootstrapEntrypoint);
    this.bootstrapVersion = options.bootstrapVersion ?? ATALK_SDK_VERSION;
    if (!parseSemver(this.bootstrapVersion)) throw new Error("bootstrapVersion must be an exact semantic version");
    this.dependencies = { ...defaultRuntimeManagerDependencies(), ...options.dependencies };
    if (pathIsWithin(this.versionsDirectory, this.paths.credentialPath)
      || pathIsWithin(this.versionsDirectory, this.paths.updateStatusPath)) {
      throw new Error("Credentials and update status must remain outside staged runtime directories");
    }
  }

  async initialize(): Promise<ActiveRuntimeMarker> {
    await mkdir(this.versionsDirectory, { recursive: true, mode: 0o700 });
    const existing = await this.readActiveMarker();
    if (existing) {
      try {
        return await this.validateLaunchMarker(existing);
      } catch {
        // Fall through only to an equal/newer packaged bootstrap. Never
        // silently downgrade a missing or corrupted verified runtime.
      }
      if (compareSemver(this.bootstrapVersion, existing.version) < 0) {
        throw new Error(`Active runtime ${existing.version} is unavailable and packaged bootstrap ${this.bootstrapVersion} would be a downgrade`);
      }
    }
    await access(this.bootstrapEntrypoint);
    const marker: ActiveRuntimeMarker = {
      version: this.bootstrapVersion,
      entrypoint: this.bootstrapEntrypoint,
      activatedAt: this.dependencies.now().toISOString(),
      source: "BOOTSTRAP",
    };
    await this.writeActiveMarker(marker);
    return marker;
  }

  async status(): Promise<RuntimeManagerSnapshot> {
    const active = await this.readActiveMarker();
    const status = await this.readRuntimeStatus();
    const quarantinedCandidate = await this.readQuarantine();
    const rawDecision = status && !timestampWithinWindow(
      status.advisory.checkedAt,
      this.dependencies.now(),
      MANUAL_ADVISORY_MAX_AGE_MS,
    )
      ? staleAdvisoryDecision(status.advisory.policy)
      : decideRuntimeUpdate(status?.advisory, active?.version, this.localPolicy);
    const persistedStagingRetry = await this.readStagingRetry();
    const stagingRetry = persistedStagingRetry?.candidateVersion === rawDecision.candidateVersion
      ? persistedStagingRetry
      : null;
    const persistedManualApproval = await this.readManualApproval();
    const manualApproval = persistedManualApproval?.candidateVersion === rawDecision.candidateVersion
      ? persistedManualApproval
      : null;
    return {
      active,
      status,
      decision: applyStagingBackoff(
        applyCandidateQuarantine(applyManualApproval(rawDecision, manualApproval), quarantinedCandidate),
        stagingRetry,
        this.dependencies.now(),
      ),
      quarantinedCandidate,
      stagingRetry,
      manualApproval,
      updateInProgress: await this.lockIsHeld(this.lockPath),
      supervisorActive: await this.lockIsHeld(this.supervisorLockPath),
    };
  }

  async update(options: { dryRun?: boolean } = {}): Promise<RuntimeUpdateResult> {
    const active = options.dryRun
      ? (await this.readActiveMarker()) ?? {
          version: this.bootstrapVersion,
          entrypoint: this.bootstrapEntrypoint,
          activatedAt: this.dependencies.now().toISOString(),
          source: "BOOTSTRAP" as const,
        }
      : await this.initialize();
    const runtimeStatus = await this.readRuntimeStatus();
    const rawDecision = options.dryRun && runtimeStatus && !timestampWithinWindow(
      runtimeStatus.advisory.checkedAt,
      this.dependencies.now(),
      MANUAL_ADVISORY_MAX_AGE_MS,
    )
      ? staleAdvisoryDecision(runtimeStatus.advisory.policy)
      : decideRuntimeUpdate(runtimeStatus?.advisory, active.version, this.localPolicy);
    const manualApproval = await this.readManualApproval();
    const decision = options.dryRun
      ? applyStagingBackoff(
          applyCandidateQuarantine(applyManualApproval(rawDecision, manualApproval), await this.readQuarantine()),
          await this.readStagingRetry(),
          this.dependencies.now(),
        )
      : rawDecision;
    if (options.dryRun || !decision.candidateVersion
      || (decision.action !== "UPDATE" && decision.action !== "NOTIFY")) {
      return { decision, changed: false, active };
    }
    if (await this.lockIsHeld(this.supervisorLockPath)) {
      throw new Error("The Runtime Manager is active; it will apply the advisory through its supervised health gate");
    }
    return this.withUpdateLock(async () => {
      if (await this.lockIsHeld(this.supervisorLockPath)) {
        throw new Error("The Runtime Manager is active; it will apply the advisory through its supervised health gate");
      }
      const current = await this.initialize();
      const latestStatus = await this.readRuntimeStatus();
      if (!latestStatus || !timestampWithinWindow(
        latestStatus.advisory.checkedAt,
        this.dependencies.now(),
        MANUAL_ADVISORY_MAX_AGE_MS,
      )) {
        throw new Error("The runtime advisory is stale; start the supervised gateway to obtain a fresh signed-in check-in before approving an update");
      }
      const latestDecision = decideRuntimeUpdate(latestStatus?.advisory, current.version, this.localPolicy);
      if (!latestDecision.candidateVersion
        || (latestDecision.action !== "UPDATE" && latestDecision.action !== "NOTIFY")) {
        return { decision: latestDecision, changed: false, active: current };
      }
      const quarantine = await this.readQuarantine();
      const retryingQuarantined = quarantine?.candidateVersion === latestDecision.candidateVersion;
      let candidate: ActiveRuntimeMarker;
      try {
        candidate = await this.stage(latestDecision.candidateVersion);
      } catch (error) {
        await this.recordStagingFailure(latestDecision.candidateVersion, error);
        throw error;
      }
      await this.clearStagingRetry().catch((error: unknown) => {
        process.stderr.write(`[aTalk Runtime Manager] Could not clear an old staging retry record: ${errorMessage(error)}\n`);
      });
      if (retryingQuarantined) await this.clearQuarantine();
      if (latestDecision.action === "NOTIFY") {
        await this.writeManualApproval({
          version: 1,
          candidateVersion: latestDecision.candidateVersion,
          approvedAt: this.dependencies.now().toISOString(),
        });
      }
      // One-shot update never swaps a live marker without a parent process to
      // health-gate it. `manager start` downloads and verifies a fresh tree,
      // then owns the atomic activation/restart/rollback transaction.
      return {
        decision: latestDecision,
        changed: true,
        active: current,
        stagedVersion: candidate.version,
        ...(latestDecision.action === "NOTIFY" ? { approvedVersion: candidate.version } : {}),
      };
    });
  }

  /** Own the gateway child, reconcile advisories, restart, health-check and roll back on failure. */
  async run(signal?: AbortSignal): Promise<void> {
    await this.assertPairedCredentials();
    await this.withSupervisorLock(async () => {
      let active = await this.initialize();
      let child: ManagedRuntimeChild | undefined;
      let peerId: string | undefined;
      let restartAttempts = 0;
      try {
        while (!signal?.aborted) {
          if (!child) {
            try {
              child = await this.launch(active);
              peerId = (await this.waitForHealth(active, child, peerId)).peerId;
            } catch (error) {
              await child?.stop().catch(() => undefined);
              child = undefined;
              process.stderr.write(`[aTalk Runtime Manager] Gateway restart failed: ${errorMessage(error)}\n`);
              const retryDelay = CHILD_RESTART_DELAYS_MS[Math.min(restartAttempts, CHILD_RESTART_DELAYS_MS.length - 1)]!;
              restartAttempts += 1;
              await this.dependencies.sleep(retryDelay, signal);
              continue;
            }
          }
          try {
            const transition = await this.updateRunning(child, active, peerId);
            child = transition.child;
            active = transition.result.active ?? active;
            peerId = transition.health?.peerId ?? peerId;
          } catch (error) {
            // A stage/registry error happens while the current child is still
            // alive. Keep supervising it and retry after the next advisory poll.
            process.stderr.write(`[aTalk Runtime Manager] ${errorMessage(error)}\n`);
          }
          const observedChild = child;
          const outcome = await Promise.race([
            this.dependencies.sleep(this.pollIntervalMs, signal).then(() => "poll" as const),
            observedChild.exited.then(
              () => "exited" as const,
              () => "exited" as const,
            ),
          ]);
          if (signal?.aborted) break;
          if (outcome === "exited") {
            const restartDelay = CHILD_RESTART_DELAYS_MS[Math.min(restartAttempts, CHILD_RESTART_DELAYS_MS.length - 1)]!;
            restartAttempts += 1;
            await this.dependencies.sleep(restartDelay, signal);
            if (signal?.aborted) break;
            // Retain the supervisor's in-memory marker. A child cannot redirect
            // its relaunch by rewriting active.json immediately before exit.
            child = undefined;
          } else {
            // One full healthy polling interval breaks the crash-loop backoff.
            restartAttempts = 0;
          }
        }
      } finally {
        await child?.stop().catch(() => undefined);
      }
    });
  }

  private async updateRunning(
    currentChild: ManagedRuntimeChild,
    retainedActive: ActiveRuntimeMarker,
    peerId?: string,
  ): Promise<{
    result: RuntimeUpdateResult;
    child: ManagedRuntimeChild;
    health?: RuntimeHealthReport;
  }> {
    const active = await this.validateLaunchMarker(retainedActive);
    const runtimeStatus = await this.readRuntimeStatus();
    if (!runtimeStatus || !runtimeStatusFromChild(runtimeStatus, currentChild, active, this.dependencies.now())) {
      return {
        result: {
          decision: {
            action: "NONE",
            reason: "Waiting for a fresh advisory from the currently supervised gateway process",
            effectivePolicy: runtimeStatus?.advisory.policy ?? "NOTIFY",
          },
          changed: false,
          active,
        },
        child: currentChild,
      };
    }
    const manualApproval = await this.readManualApproval();
    const initialDecision = applyStagingBackoff(
      applyCandidateQuarantine(
        applyManualApproval(decideRuntimeUpdate(runtimeStatus.advisory, active.version, this.localPolicy), manualApproval),
        await this.readQuarantine(),
      ),
      await this.readStagingRetry(),
      this.dependencies.now(),
    );
    if (initialDecision.action !== "UPDATE" || !initialDecision.candidateVersion) {
      return { result: { decision: initialDecision, changed: false, active }, child: currentChild };
    }
    return this.withUpdateLock(async () => {
      const previous = await this.validateLaunchMarker(active);
      const latestStatus = await this.readRuntimeStatus();
      if (!latestStatus || !runtimeStatusFromChild(latestStatus, currentChild, previous, this.dependencies.now())) {
        return {
          result: {
            decision: {
              action: "NONE",
              reason: "Waiting for a fresh advisory from the currently supervised gateway process",
              effectivePolicy: latestStatus?.advisory.policy ?? "NOTIFY",
            },
            changed: false,
            active: previous,
          },
          child: currentChild,
        };
      }
      const decision = applyStagingBackoff(
        applyCandidateQuarantine(
          applyManualApproval(decideRuntimeUpdate(latestStatus.advisory, previous.version, this.localPolicy), await this.readManualApproval()),
          await this.readQuarantine(),
        ),
        await this.readStagingRetry(),
        this.dependencies.now(),
      );
      if (decision.action !== "UPDATE" || !decision.candidateVersion) {
        return { result: { decision, changed: false, active: previous }, child: currentChild };
      }
      let candidate: ActiveRuntimeMarker;
      try {
        candidate = await this.stage(decision.candidateVersion);
      } catch (error) {
        await this.recordStagingFailure(decision.candidateVersion, error);
        throw error;
      }
      await this.clearStagingRetry().catch((error: unknown) => {
        process.stderr.write(`[aTalk Runtime Manager] Could not clear an old staging retry record: ${errorMessage(error)}\n`);
      });
      if (manualApproval?.candidateVersion === candidate.version) {
        await this.clearManualApproval();
      }
      await currentChild.stop();
      let candidateChild: ManagedRuntimeChild | undefined;
      try {
        candidateChild = await this.launch(candidate);
        const health = await this.waitForHealth(candidate, candidateChild, peerId);
        await Promise.race([
          this.waitForFreshRuntimeStatus(candidate, candidateChild),
          candidateChild.exited.then((code) => {
            throw new Error(`Gateway process exited before publishing its runtime sidecar (${code ?? "signal"})`);
          }),
        ]);
        // Commit the marker only after the exact candidate PID reconnects as
        // the same agent. If the supervisor is killed during the probe, IPC
        // stops the candidate and the durable marker still names last-known-good.
        const activatedCandidate: ActiveRuntimeMarker = {
          ...candidate,
          activatedAt: this.dependencies.now().toISOString(),
          source: "VERIFIED",
        };
        await this.writeActiveMarker(activatedCandidate);
        await this.clearQuarantine().catch((error: unknown) => {
          process.stderr.write(`[aTalk Runtime Manager] Could not clear an old quarantine record: ${errorMessage(error)}\n`);
        });
        return { result: { decision, changed: true, active: activatedCandidate }, child: candidateChild, health };
      } catch (error) {
        await candidateChild?.stop().catch(() => undefined);
        const candidateFailure = `Candidate failed health checks: ${errorMessage(error)}`;
        // Quarantine before attempting rollback. Even if the previous runtime
        // cannot be relaunched yet, the supervisor must not interrupt it again
        // with the same known-bad exact candidate after recovery.
        await this.writeQuarantine({
          version: 1,
          candidateVersion: candidate.version,
          advisoryCheckedAt: latestStatus?.advisory.checkedAt ?? this.dependencies.now().toISOString(),
          failedAt: this.dependencies.now().toISOString(),
          reason: candidateFailure,
        });
        let restored: ManagedRuntimeChild;
        try {
          restored = await this.launch(previous);
        } catch (rollbackError) {
          throw new Error(`Candidate was quarantined and the previous runtime could not be restored: ${errorMessage(rollbackError)}`);
        }
        let restoredHealth: RuntimeHealthReport;
        try {
          restoredHealth = await this.waitForHealth(previous, restored, peerId);
        } catch (rollbackError) {
          await restored.stop().catch(() => undefined);
          throw new Error(`Candidate was quarantined and the previous runtime could not be restored: ${errorMessage(rollbackError)}`);
        }
        const message = `${candidateFailure}; restored the last-known-good runtime`;
        process.stderr.write(`[aTalk Runtime Manager] ${message}\n`);
        return {
          result: { decision, changed: false, active: previous, rolledBack: true, error: message },
          child: restored,
          health: restoredHealth,
        };
      }
    });
  }

  private async stage(version: string): Promise<ActiveRuntimeMarker> {
    if (!parseSemver(version)) throw new Error(`Refusing invalid runtime version: ${version}`);
    const finalDirectory = join(this.versionsDirectory, version);
    const entrypoint = gatewayEntrypoint(finalDirectory);
    // Inactive candidates are never cache hits. A manually staged directory
    // can be modified before a later supervised attempt, so reconstruct the
    // exact version from the registry artifact every time it becomes eligible.
    await rm(finalDirectory, { recursive: true, force: true });
    const stageDirectory = await mkdtemp(join(this.versionsDirectory, `.${version}.staging-`));
    try {
      const artifact = await this.dependencies.resolveArtifact(MANAGED_GATEWAY_PACKAGE, version);
      if (artifact.packageName !== MANAGED_GATEWAY_PACKAGE || artifact.version !== version) {
        throw new Error("Registry returned a different package identity or version");
      }
      await this.dependencies.installArtifact(artifact, stageDirectory);
      await verifyInstalledGateway(stageDirectory, version);
      const dependencyLockDigest = await installedRuntimeDependencyLockDigest(stageDirectory, version);
      const stagedEntrypoint = gatewayEntrypoint(stageDirectory);
      const selfTestHome = join(stageDirectory, ".self-test-home");
      await mkdir(selfTestHome, { recursive: true, mode: 0o700 });
      await this.dependencies.selfTest(stagedEntrypoint, offlineSelfTestEnvironment(selfTestHome));
      await rm(selfTestHome, { recursive: true, force: true });
      const receipt: RuntimeVerificationReceipt = {
        version: 1,
        packageName: artifact.packageName,
        packageVersion: artifact.version,
        tarballUrl: artifact.tarballUrl,
        integrity: artifact.integrity,
        shasum: artifact.shasum,
        provenanceUrl: artifact.provenanceUrl,
        dependencyLockDigest,
        treeDigest: await runtimeTreeDigest(stageDirectory),
        verifiedAt: this.dependencies.now().toISOString(),
      };
      await atomicJsonWrite(join(stageDirectory, RUNTIME_RECEIPT_NAME), receipt);
      await rename(stageDirectory, finalDirectory);
    } catch (error) {
      await rm(stageDirectory, { recursive: true, force: true });
      throw error;
    }
    return { version, entrypoint, activatedAt: this.dependencies.now().toISOString(), source: "VERIFIED" };
  }

  private managedEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ...this.childEnvironment,
      ATALK_RUNTIME_MANAGER: "1",
      ATALK_RUNTIME_MANAGED: "1",
      ATALK_RUNTIME_SUPERVISOR_LEASE: this.supervisorLockPath,
      ...(this.supervisorNonce ? { ATALK_RUNTIME_SUPERVISOR_NONCE: this.supervisorNonce } : {}),
      ATALK_UPDATE_STATUS_PATH: this.paths.updateStatusPath,
      ATALK_CREDENTIAL_PATH: this.paths.credentialPath,
      ATALK_GATEWAY_HOST: this.gatewayHost,
      ATALK_GATEWAY_PORT: String(this.gatewayPort),
      ...(this.gatewayApiKey ? { ATALK_GATEWAY_API_KEY: this.gatewayApiKey } : {}),
    };
    // Activation codes are one-time secrets for `pair`; a supervisor only
    // reuses the persisted credential/key file and never forwards the code.
    delete environment.ATALK_AGENT_TOKEN;
    return environment;
  }

  private async launch(marker: ActiveRuntimeMarker): Promise<ManagedRuntimeChild> {
    const validatedMarker = await this.validateLaunchMarker(marker);
    const launchId = randomUUID();
    const child = await this.dependencies.launch(validatedMarker.entrypoint, this.childArgs, {
      ...this.managedEnvironment(),
      ATALK_RUNTIME_LAUNCH_ID: launchId,
    });
    Object.defineProperty(child, "launchId", { value: launchId, enumerable: true });
    return child;
  }

  private async validateLaunchMarker(marker: ActiveRuntimeMarker): Promise<ActiveRuntimeMarker> {
    if (marker.source === "BOOTSTRAP") {
      if (marker.version !== this.bootstrapVersion
        || resolve(marker.entrypoint) !== this.bootstrapEntrypoint) {
        throw new Error("Active bootstrap marker does not match the packaged Gateway runtime");
      }
      await access(this.bootstrapEntrypoint);
      return { ...marker, entrypoint: this.bootstrapEntrypoint, source: "BOOTSTRAP" };
    }
    const runtimeDirectory = join(this.versionsDirectory, marker.version);
    const canonicalEntrypoint = gatewayEntrypoint(runtimeDirectory);
    if (resolve(marker.entrypoint) !== resolve(canonicalEntrypoint)) {
      throw new Error("Verified runtime marker does not use its canonical Gateway entrypoint");
    }
    await verifyReusableRuntime(runtimeDirectory, marker.version);
    return { ...marker, entrypoint: canonicalEntrypoint, source: "VERIFIED" };
  }

  private async assertPairedCredentials(): Promise<void> {
    const linkMetadata = await lstat(this.paths.credentialPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        throw new Error("Pair the agent before starting the Runtime Manager; persisted credentials were not found");
      }
      throw error;
    });
    if (linkMetadata.isSymbolicLink()) throw new Error("The configured aTalk credential path must not be a symbolic link");
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    const handle = await open(this.paths.credentialPath, flags);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_CREDENTIAL_BYTES) {
        throw new Error("The configured aTalk credential path is not a bounded regular credential file");
      }
      if (process.platform !== "win32") {
        if ((metadata.mode & 0o077) !== 0) {
          throw new Error("The aTalk credential file must not be accessible by group or other users (chmod 600)");
        }
        const currentUserId = process.getuid?.();
        if (currentUserId !== undefined && metadata.uid !== currentUserId) {
          throw new Error("The aTalk credential file must be owned by the Runtime Manager user");
        }
      }
      const parsed = JSON.parse((await handle.readFile({ encoding: "utf8" }))) as unknown;
      if (!isRecord(parsed)) throw new Error("The configured aTalk credential file is malformed");
    } finally {
      await handle.close();
    }
  }

  private async waitForHealth(
    marker: ActiveRuntimeMarker,
    child: ManagedRuntimeChild,
    peerId?: string,
  ): Promise<RuntimeHealthReport> {
    const exited = child.exited.then((code) => {
      throw new Error(`Gateway process exited before completing health probation (${code ?? "signal"})`);
    });
    let health = await Promise.race([this.pollForHealth(marker, child.pid, peerId), exited]);
    for (let check = 1; check < HEALTH_PROBATION_CHECKS; check += 1) {
      await Promise.race([this.dependencies.sleep(HEALTH_PROBATION_INTERVAL_MS), exited]);
      health = await Promise.race([this.pollForHealth(marker, child.pid, health.peerId), exited]);
    }
    return health;
  }

  private async pollForHealth(
    marker: ActiveRuntimeMarker,
    processId?: number,
    peerId?: string,
  ): Promise<RuntimeHealthReport> {
    const deadline = this.dependencies.now().getTime() + this.healthTimeoutMs;
    const host = this.gatewayHost === "::1" ? "[::1]" : this.gatewayHost;
    const url = `http://${host}:${this.gatewayPort}/health`;
    do {
      const health = await this.dependencies.healthCheck(url, {
        integrationName: MANAGED_GATEWAY_PACKAGE,
        integrationVersion: marker.version,
        ...(processId !== undefined ? { processId } : {}),
        ...(peerId ? { peerId } : {}),
      }, this.gatewayApiKey).catch(() => false as const);
      if (health) return health;
      await this.dependencies.sleep(250);
    } while (this.dependencies.now().getTime() < deadline);
    throw new Error(`Gateway did not reconnect and become healthy at ${url}`);
  }

  private async waitForFreshRuntimeStatus(
    marker: ActiveRuntimeMarker,
    child: ManagedRuntimeChild,
  ): Promise<PersistedRuntimeUpdateStatus> {
    const attempts = Math.max(1, Math.ceil(this.healthTimeoutMs / 250));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.readRuntimeStatus();
      if (runtimeStatusFromChild(status, child, marker, this.dependencies.now())) return status!;
      if (attempt + 1 < attempts) await this.dependencies.sleep(250);
    }
    throw new Error("Gateway became healthy but did not publish a fresh runtime advisory sidecar");
  }

  private async readActiveMarker(): Promise<ActiveRuntimeMarker | null> {
    const value = await readJsonIfPresent(this.markerPath);
    if (!isRecord(value) || typeof value.version !== "string" || !parseSemver(value.version)
      || typeof value.entrypoint !== "string" || !value.entrypoint
      || typeof value.activatedAt !== "string" || !Number.isFinite(Date.parse(value.activatedAt))) return null;
    const entrypoint = resolve(value.entrypoint);
    if (value.source !== "VERIFIED" && value.source !== "BOOTSTRAP") return null;
    const source = value.source;
    return { version: value.version, entrypoint, activatedAt: value.activatedAt, source };
  }

  private async readRuntimeStatus(): Promise<PersistedRuntimeUpdateStatus | null> {
    const value = await readJsonIfPresent(this.paths.updateStatusPath);
    if (!isRecord(value) || value.version !== MANAGER_VERSION || !isRuntimeMetadata(value.metadata)) return null;
    const advisory = parseRuntimeUpdateAdvisory(value.advisory);
    if (!advisory) return null;
    // The server cannot redirect this manager to another package. Only an
    // advisory written by the official gateway integration is actionable.
    if (value.metadata.integration.name !== MANAGED_GATEWAY_PACKAGE) return null;
    const writerProcessId = typeof value.writerProcessId === "number"
      && Number.isSafeInteger(value.writerProcessId) && value.writerProcessId > 0
      ? value.writerProcessId
      : undefined;
    const writerLaunchId = typeof value.writerLaunchId === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.writerLaunchId)
      ? value.writerLaunchId
      : undefined;
    return {
      version: 1,
      ...(writerProcessId ? { writerProcessId } : {}),
      ...(writerLaunchId ? { writerLaunchId } : {}),
      metadata: value.metadata,
      advisory,
    };
  }

  private async readQuarantine(): Promise<RuntimeCandidateQuarantine | null> {
    if (this.volatileQuarantine) return this.volatileQuarantine;
    const value = await readJsonIfPresent(this.quarantinePath);
    if (!isRecord(value) || value.version !== 1 || typeof value.candidateVersion !== "string"
      || !parseSemver(value.candidateVersion) || typeof value.advisoryCheckedAt !== "string"
      || !Number.isFinite(Date.parse(value.advisoryCheckedAt)) || typeof value.failedAt !== "string"
      || !Number.isFinite(Date.parse(value.failedAt)) || typeof value.reason !== "string") return null;
    return {
      version: 1,
      candidateVersion: value.candidateVersion,
      advisoryCheckedAt: value.advisoryCheckedAt,
      failedAt: value.failedAt,
      reason: value.reason,
    };
  }

  private async writeQuarantine(quarantine: RuntimeCandidateQuarantine): Promise<void> {
    this.volatileQuarantine = quarantine;
    try {
      await mkdir(dirname(this.quarantinePath), { recursive: true, mode: 0o700 });
      await atomicJsonWrite(this.quarantinePath, quarantine);
    } catch (error) {
      // The in-memory record still protects this supervisor run. Keep the
      // restored child under management even if persistence is unavailable.
      process.stderr.write(`[aTalk Runtime Manager] Could not persist candidate quarantine: ${errorMessage(error)}\n`);
    }
  }

  private async clearQuarantine(): Promise<void> {
    this.volatileQuarantine = undefined;
    await rm(this.quarantinePath, { force: true });
  }

  private async readStagingRetry(): Promise<RuntimeStagingRetry | null> {
    if (this.volatileStagingRetry) return this.volatileStagingRetry;
    const value = await readJsonIfPresent(this.stagingRetryPath);
    if (!isRecord(value) || value.version !== 1 || typeof value.candidateVersion !== "string"
      || !parseSemver(value.candidateVersion) || typeof value.attempts !== "number"
      || !Number.isSafeInteger(value.attempts) || value.attempts < 1
      || typeof value.failedAt !== "string" || !Number.isFinite(Date.parse(value.failedAt))
      || typeof value.nextRetryAt !== "string" || !Number.isFinite(Date.parse(value.nextRetryAt))
      || typeof value.reason !== "string") return null;
    return {
      version: 1,
      candidateVersion: value.candidateVersion,
      attempts: value.attempts,
      failedAt: value.failedAt,
      nextRetryAt: value.nextRetryAt,
      reason: value.reason,
    };
  }

  private async recordStagingFailure(candidateVersion: string, error: unknown): Promise<void> {
    const existing = await this.readStagingRetry();
    const attempts = existing?.candidateVersion === candidateVersion ? existing.attempts + 1 : 1;
    const delay = STAGING_RETRY_DELAYS_MS[Math.min(attempts - 1, STAGING_RETRY_DELAYS_MS.length - 1)]!;
    const now = this.dependencies.now();
    const retry: RuntimeStagingRetry = {
      version: 1,
      candidateVersion,
      attempts,
      failedAt: now.toISOString(),
      nextRetryAt: new Date(now.getTime() + delay).toISOString(),
      reason: errorMessage(error),
    };
    this.volatileStagingRetry = retry;
    try {
      await mkdir(dirname(this.stagingRetryPath), { recursive: true, mode: 0o700 });
      await atomicJsonWrite(this.stagingRetryPath, retry);
    } catch (writeError) {
      process.stderr.write(`[aTalk Runtime Manager] Could not persist staging retry state: ${errorMessage(writeError)}\n`);
    }
  }

  private async clearStagingRetry(): Promise<void> {
    this.volatileStagingRetry = undefined;
    await rm(this.stagingRetryPath, { force: true });
  }

  private async readManualApproval(): Promise<RuntimeManualApproval | null> {
    const value = await readJsonIfPresent(this.manualApprovalPath);
    if (!isRecord(value) || value.version !== 1 || typeof value.candidateVersion !== "string"
      || !parseSemver(value.candidateVersion) || typeof value.approvedAt !== "string"
      || !Number.isFinite(Date.parse(value.approvedAt))
      || !timestampWithinWindow(value.approvedAt, this.dependencies.now(), MANUAL_APPROVAL_MAX_AGE_MS)) return null;
    return { version: 1, candidateVersion: value.candidateVersion, approvedAt: value.approvedAt };
  }

  private async writeManualApproval(approval: RuntimeManualApproval): Promise<void> {
    await mkdir(dirname(this.manualApprovalPath), { recursive: true, mode: 0o700 });
    await atomicJsonWrite(this.manualApprovalPath, approval);
  }

  private async clearManualApproval(): Promise<void> {
    await rm(this.manualApprovalPath, { force: true });
  }

  private async writeActiveMarker(marker: ActiveRuntimeMarker): Promise<void> {
    await mkdir(dirname(this.markerPath), { recursive: true, mode: 0o700 });
    await atomicJsonWrite(this.markerPath, marker);
  }

  private async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(this.lockPath, "Another runtime update is already in progress");
    try {
      return await operation();
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  private async withSupervisorLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(this.supervisorLockPath, "Another Runtime Manager supervisor is already active");
    this.supervisorNonce = lock.nonce;
    try {
      return await operation();
    } finally {
      this.supervisorNonce = undefined;
      await lock.release().catch(() => undefined);
    }
  }

  private async acquireLock(
    path: string,
    contentionMessage: string,
  ): Promise<ManagedLock> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
      });
    } catch (error) {
      if (isRecord(error) && error.code === "ELOCKED") throw new Error(contentionMessage);
      throw error;
    }
    try {
      const nonce = randomUUID();
      await atomicJsonWrite(path, {
        pid: process.pid,
        nonce,
        startedAt: this.dependencies.now().toISOString(),
      });
      return { nonce, release };
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }

  private async lockIsHeld(path: string): Promise<boolean> {
    return lockfile.check(path, { realpath: false, stale: LOCK_STALE_MS });
  }
}

function defaultRuntimeManagerDependencies(): RuntimeManagerDependencies {
  return {
    resolveArtifact: resolveNpmArtifact,
    installArtifact: installVerifiedNpmArtifact,
    selfTest: defaultSelfTest,
    launch: launchManagedChild,
    healthCheck: defaultHealthCheck,
    now: () => new Date(),
    sleep: abortableSleep,
  };
}

async function resolveNpmArtifact(
  packageName: typeof MANAGED_GATEWAY_PACKAGE,
  version: string,
): Promise<NpmRuntimeArtifact> {
  if (!parseSemver(version)) throw new Error("The registry lookup requires an exact semantic version");
  const endpoint = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const response = await fetch(endpoint, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_METADATA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry lookup failed (${response.status})`);
  const value = JSON.parse((await boundedResponseBody(response, MAX_REGISTRY_METADATA_BYTES, "npm metadata")).toString("utf8")) as unknown;
  if (!isRecord(value) || value.name !== packageName || value.version !== version || !isRecord(value.dist)
    || typeof value.dist.tarball !== "string" || typeof value.dist.integrity !== "string"
    || typeof value.dist.shasum !== "string" || !/^[a-f0-9]{40}$/iu.test(value.dist.shasum)) {
    throw new Error("npm registry returned incomplete or mismatched package metadata");
  }
  const attestations = isRecord(value.dist.attestations) ? value.dist.attestations : undefined;
  const provenance = attestations && isRecord(attestations.provenance) ? attestations.provenance : undefined;
  if (!attestations || typeof attestations.url !== "string"
    || provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
    throw new Error("The official Gateway release is missing required SLSA provenance metadata");
  }
  assertOfficialRegistryUrl(value.dist.tarball, "tarball");
  assertOfficialRegistryUrl(attestations.url, "provenance");
  return {
    packageName,
    version,
    tarballUrl: value.dist.tarball,
    integrity: value.dist.integrity,
    shasum: value.dist.shasum,
    provenanceUrl: attestations.url,
  };
}

async function installVerifiedNpmArtifact(artifact: NpmRuntimeArtifact, stageDirectory: string): Promise<void> {
  assertOfficialRegistryUrl(artifact.tarballUrl, "tarball");
  const response = await fetch(artifact.tarballUrl, { signal: AbortSignal.timeout(REGISTRY_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`npm tarball download failed (${response.status})`);
  const bytes = await boundedResponseBody(response, MAX_PACKAGE_BYTES, "npm tarball");
  verifyNpmArtifactIntegrity(bytes, artifact.integrity, artifact.shasum);
  const dependencyLock = runtimeDependencyLockFromTarball(bytes, artifact);
  assertOfficialRegistryUrl(artifact.provenanceUrl, "provenance");
  const exactSpec = `${MANAGED_GATEWAY_PACKAGE}@${artifact.version}`;
  const overrides = Object.fromEntries(
    Object.entries(dependencyLock.packages).filter(([name]) => name !== MANAGED_GATEWAY_PACKAGE),
  );
  await atomicJsonWrite(join(stageDirectory, "package.json"), {
    private: true,
    type: "module",
    dependencies: { [MANAGED_GATEWAY_PACKAGE]: artifact.version },
    overrides,
  });
  await runProcess("npm", [
    "install", "--prefix", stageDirectory, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev",
    "--registry=https://registry.npmjs.org/", exactSpec,
  ], sanitizedInstallerEnvironment(), 120_000);
  await verifyNpmLockArtifact(stageDirectory, artifact, dependencyLock);
  const audit = await runJsonProcess("npm", [
    "audit", "signatures", "--json", "--include-attestations", "--prefix", stageDirectory,
    "--registry=https://registry.npmjs.org/",
  ], sanitizedInstallerEnvironment(), 60_000);
  verifyNpmAuditReport(audit, artifact);
}

async function defaultSelfTest(entrypoint: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await runProcess(process.execPath, [entrypoint, "self-test"], environment, 45_000);
}

async function launchManagedChild(
  entrypoint: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ManagedRuntimeChild> {
  // The IPC descriptor is a parent-death signal. A managed gateway listens for
  // disconnect and exits, so SIGKILL/OOM of the supervisor cannot leave an
  // orphan still claiming runtime.auto-update or holding the HTTP port.
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env: environment,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code));
  });
  return {
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    exited,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 10_000)),
      ]);
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited.catch(() => undefined);
      }
    },
  };
}

async function defaultHealthCheck(
  url: string,
  expectation: RuntimeHealthExpectation,
  apiKey?: string,
): Promise<RuntimeHealthReport | false> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(2_000),
    ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
  });
  if (!response.ok) return false;
  const value = JSON.parse((await boundedResponseBody(response, MAX_HEALTH_RESPONSE_BYTES, "Gateway health response")).toString("utf8")) as unknown;
  return parseRuntimeHealthReport(value, expectation);
}

export function parseRuntimeHealthReport(
  value: unknown,
  expectation: RuntimeHealthExpectation,
): RuntimeHealthReport | false {
  if (!isRecord(value) || value.status !== "ok" || value.connected !== true
    || !isRecord(value.identity) || typeof value.identity.id !== "string"
    || !isRecord(value.runtime) || typeof value.runtime.processId !== "number"
    || !isRecord(value.runtime.metadata) || !isRecord(value.runtime.metadata.integration)
    || value.runtime.metadata.integration.name !== expectation.integrationName
    || value.runtime.metadata.integration.version !== expectation.integrationVersion
    || (expectation.processId !== undefined && value.runtime.processId !== expectation.processId)
    || (expectation.peerId !== undefined && value.identity.id !== expectation.peerId)) return false;
  return {
    peerId: value.identity.id,
    integrationVersion: value.runtime.metadata.integration.version,
    processId: value.runtime.processId,
  };
}

async function verifyInstalledGateway(directory: string, version: string): Promise<void> {
  const manifest = await readJsonIfPresent(join(directory, "node_modules", "@atalk", "gateway", "package.json"));
  if (!isRecord(manifest) || manifest.name !== MANAGED_GATEWAY_PACKAGE || manifest.version !== version) {
    throw new Error("Staged runtime package identity/version verification failed");
  }
  await access(gatewayEntrypoint(directory));
  await installedRuntimeDependencyLock(directory, version);
}

async function verifyReusableRuntime(directory: string, version: string): Promise<void> {
  await verifyInstalledGateway(directory, version);
  const value = await readJsonIfPresent(join(directory, RUNTIME_RECEIPT_NAME));
  if (!isRecord(value) || value.version !== 1 || value.packageName !== MANAGED_GATEWAY_PACKAGE
    || value.packageVersion !== version || typeof value.tarballUrl !== "string"
    || typeof value.integrity !== "string" || typeof value.shasum !== "string"
    || !/^[a-f0-9]{40}$/iu.test(value.shasum) || typeof value.provenanceUrl !== "string"
    || typeof value.dependencyLockDigest !== "string" || !/^[a-f0-9]{64}$/iu.test(value.dependencyLockDigest)
    || typeof value.treeDigest !== "string" || !/^[a-f0-9]{64}$/iu.test(value.treeDigest)
    || typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt))) {
    throw new Error("Staged runtime has no valid local verification receipt");
  }
  assertOfficialRegistryUrl(value.tarballUrl, "receipt tarball");
  assertOfficialRegistryUrl(value.provenanceUrl, "receipt provenance");
  const actualDependencyLockDigest = await installedRuntimeDependencyLockDigest(directory, version);
  if (!safeHexEqual(actualDependencyLockDigest, value.dependencyLockDigest)) {
    throw new Error("Staged runtime dependency lock changed after verification");
  }
  const actualDigest = await runtimeTreeDigest(directory);
  const actual = Buffer.from(actualDigest, "hex");
  const expected = Buffer.from(value.treeDigest, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Staged runtime changed after verification");
  }
}

async function runtimeTreeDigest(directory: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => !(current === directory && entry.name === RUNTIME_RECEIPT_NAME))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = relative(directory, path).split(sep).join("/");
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        digest.update(`d\0${relativePath}\0`);
        await visit(path);
      } else if (metadata.isFile()) {
        digest.update(`f\0${relativePath}\0${metadata.size}\0`);
        digest.update(await readFile(path));
      } else if (metadata.isSymbolicLink()) {
        digest.update(`l\0${relativePath}\0${await readlink(path)}\0`);
      } else {
        throw new Error(`Staged runtime contains unsupported filesystem entry: ${relativePath}`);
      }
    }
  };
  await visit(directory);
  return digest.digest("hex");
}

export function runtimeDependencyLockFromTarball(
  compressedTarball: Buffer,
  artifact: NpmRuntimeArtifact,
): RuntimeDependencyLock {
  let tarball: Buffer;
  try {
    tarball = gunzipSync(compressedTarball, { maxOutputLength: MAX_UNPACKED_PACKAGE_BYTES });
  } catch {
    throw new Error("The verified Gateway tarball could not be safely decompressed");
  }
  const expectedPath = `package/${RUNTIME_DEPENDENCY_LOCK_NAME}`;
  let lockBytes: Buffer | undefined;
  for (let offset = 0; offset + 512 <= tarball.length;) {
    const header = tarball.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarHeaderString(header, 0, 100);
    const prefix = tarHeaderString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const rawSize = tarHeaderString(header, 124, 12).trim();
    if (!/^[0-7]+$/u.test(rawSize)) throw new Error("The verified Gateway tarball contains an invalid entry size");
    const size = Number.parseInt(rawSize, 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UNPACKED_PACKAGE_BYTES) {
      throw new Error("The verified Gateway tarball contains an oversized entry");
    }
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tarball.length) throw new Error("The verified Gateway tarball is truncated");
    const type = String.fromCharCode(header[156] ?? 0);
    if (path === expectedPath && (type === "\0" || type === "0")) {
      if (lockBytes) throw new Error("The verified Gateway tarball contains duplicate runtime dependency locks");
      if (size > MAX_RUNTIME_DEPENDENCY_LOCK_BYTES) throw new Error("The runtime dependency lock is oversized");
      lockBytes = Buffer.from(tarball.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!lockBytes) throw new Error("The verified Gateway release has no signed runtime dependency lock");
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("The signed runtime dependency lock is malformed JSON");
  }
  return parseRuntimeDependencyLock(parsed, artifact.version);
}

export function parseRuntimeDependencyLock(value: unknown, rootVersion: string): RuntimeDependencyLock {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.root)
    || value.root.name !== MANAGED_GATEWAY_PACKAGE || value.root.version !== rootVersion
    || !isRecord(value.packages) || !Array.isArray(value.required)) {
    throw new Error("The signed runtime dependency lock has an invalid identity or schema");
  }
  const entries = Object.entries(value.packages);
  if (entries.length < 1 || entries.length > 128) throw new Error("The signed runtime dependency lock has an invalid package count");
  const packages: Record<string, string> = {};
  for (const [name, version] of entries) {
    if (!validNpmPackageName(name) || typeof version !== "string" || !parseSemver(version)) {
      throw new Error("The signed runtime dependency lock contains an invalid package pin");
    }
    packages[name] = version;
  }
  if (packages[MANAGED_GATEWAY_PACKAGE] !== rootVersion) {
    throw new Error("The signed runtime dependency lock does not pin the exact Gateway release");
  }
  if (value.required.length < 1 || value.required.length > 128
    || value.required.some((name) => typeof name !== "string" || packages[name] === undefined)
    || new Set(value.required).size !== value.required.length
    || !value.required.includes(MANAGED_GATEWAY_PACKAGE)) {
    throw new Error("The signed runtime dependency lock has an invalid required package set");
  }
  return {
    version: 1,
    root: { name: MANAGED_GATEWAY_PACKAGE, version: rootVersion },
    packages,
    required: [...value.required] as string[],
  };
}

async function installedRuntimeDependencyLock(
  directory: string,
  version: string,
): Promise<{ lock: RuntimeDependencyLock; bytes: Buffer }> {
  const path = join(directory, "node_modules", "@atalk", "gateway", RUNTIME_DEPENDENCY_LOCK_NAME);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_RUNTIME_DEPENDENCY_LOCK_BYTES) {
    throw new Error("Staged runtime dependency lock is not a bounded regular file");
  }
  const bytes = await readFile(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Staged runtime dependency lock is malformed JSON");
  }
  return { lock: parseRuntimeDependencyLock(value, version), bytes };
}

async function installedRuntimeDependencyLockDigest(directory: string, version: string): Promise<string> {
  const { bytes } = await installedRuntimeDependencyLock(directory, version);
  return createHash("sha256").update(bytes).digest("hex");
}

function tarHeaderString(header: Buffer, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function validNpmPackageName(name: string): boolean {
  return name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name);
}

function npmPackageNameFromLockLocation(location: string): string | undefined {
  const marker = "node_modules/";
  const index = location.lastIndexOf(marker);
  if (index === -1) return undefined;
  const tail = location.slice(index + marker.length).split("/");
  return tail[0]?.startsWith("@") ? tail.slice(0, 2).join("/") : tail[0];
}

function safeHexEqual(leftHex: string, rightHex: string): boolean {
  if (!/^[a-f0-9]+$/iu.test(leftHex) || !/^[a-f0-9]+$/iu.test(rightHex)) return false;
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function verifyNpmLockArtifact(
  directory: string,
  artifact: NpmRuntimeArtifact,
  dependencyLock: RuntimeDependencyLock,
): Promise<void> {
  const lock = await readJsonIfPresent(join(directory, "package-lock.json"));
  verifyNpmDependencyLockGraph(lock, artifact, dependencyLock);
}

export function verifyNpmDependencyLockGraph(
  lock: unknown,
  artifact: NpmRuntimeArtifact,
  dependencyLock: RuntimeDependencyLock,
): void {
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : undefined;
  const entry = packages && isRecord(packages["node_modules/@atalk/gateway"])
    ? packages["node_modules/@atalk/gateway"]
    : undefined;
  if (!packages || !entry || entry.version !== artifact.version || entry.resolved !== artifact.tarballUrl
    || entry.integrity !== artifact.integrity) {
    throw new Error("Installed npm lock does not match the verified official Gateway artifact");
  }
  const installed = new Set<string>();
  for (const [location, packageEntry] of Object.entries(packages)) {
    if (location === "") continue;
    if (!isRecord(packageEntry) || typeof packageEntry.version !== "string") {
      throw new Error(`Installed npm dependency entry is not immutable: ${location}`);
    }
    const name = npmPackageNameFromLockLocation(location);
    const expectedVersion = name ? dependencyLock.packages[name] : undefined;
    if (!name || packageEntry.version !== expectedVersion) {
      throw new Error(`Installed npm dependency graph contains an unapproved package or version: ${location}@${packageEntry.version}`);
    }
    installed.add(name);
  }
  for (const required of dependencyLock.required) {
    if (!installed.has(required)) throw new Error(`Installed npm dependency graph is missing required package ${required}`);
  }
}

export function verifyNpmAuditReport(value: unknown, artifact: NpmRuntimeArtifact): void {
  if (!isRecord(value) || !Array.isArray(value.invalid) || value.invalid.length > 0
    || !Array.isArray(value.missing) || value.missing.length > 0 || !Array.isArray(value.verified)) {
    throw new Error("npm signature audit did not return a clean machine-verifiable report");
  }
  const verified = value.verified.find((item: unknown): item is Record<string, unknown> => {
    if (!isRecord(item) || item.name !== artifact.packageName || item.version !== artifact.version
      || item.location !== "node_modules/@atalk/gateway" || typeof item.registry !== "string"
      || !isRecord(item.attestations) || item.attestations.url !== artifact.provenanceUrl
      || !isRecord(item.attestations.provenance)
      || item.attestations.provenance.predicateType !== "https://slsa.dev/provenance/v1"
      || !Array.isArray(item.attestationBundles) || item.attestationBundles.length === 0) return false;
    try {
      assertOfficialRegistryUrl(item.registry, "audit registry");
      return true;
    } catch {
      return false;
    }
  });
  if (!verified) {
    throw new Error(`npm did not cryptographically verify SLSA provenance for ${artifact.packageName}@${artifact.version}`);
  }
  verifyOfficialGatewayProvenance(verified, artifact);
}

function verifyOfficialGatewayProvenance(verified: Record<string, unknown>, artifact: NpmRuntimeArtifact): void {
  const bundles = Array.isArray(verified.attestationBundles) ? verified.attestationBundles : [];
  const expectedTag = `refs/tags/node-v${artifact.version}`;
  const expectedRepository = "https://github.com/atalk-network/atalk-developers";
  const expectedWorkflowPath = ".github/workflows/release-node.yml";
  const expectedSource = `git+${expectedRepository}@${expectedTag}`;
  const expectedPurl = `pkg:npm/%40atalk/gateway@${artifact.version}`;
  const expectedSha512 = sha512HexFromIntegrity(artifact.integrity);
  const accepted = bundles.some((candidate) => {
    if (!isRecord(candidate) || candidate.predicateType !== "https://slsa.dev/provenance/v1"
      || !isRecord(candidate.bundle) || !isRecord(candidate.bundle.dsseEnvelope)
      || candidate.bundle.dsseEnvelope.payloadType !== "application/vnd.in-toto+json"
      || typeof candidate.bundle.dsseEnvelope.payload !== "string"
      || candidate.bundle.dsseEnvelope.payload.length > Math.ceil(MAX_ATTESTATION_PAYLOAD_BYTES * 4 / 3) + 4) return false;
    let statement: unknown;
    try {
      const payload = Buffer.from(candidate.bundle.dsseEnvelope.payload, "base64");
      if (payload.byteLength > MAX_ATTESTATION_PAYLOAD_BYTES) return false;
      statement = JSON.parse(payload.toString("utf8")) as unknown;
    } catch {
      return false;
    }
    if (!isRecord(statement) || statement._type !== "https://in-toto.io/Statement/v1"
      || statement.predicateType !== "https://slsa.dev/provenance/v1"
      || !Array.isArray(statement.subject) || !isRecord(statement.predicate)
      || !isRecord(statement.predicate.buildDefinition)) return false;
    const subjectMatches = statement.subject.some((subject) => isRecord(subject)
      && subject.name === expectedPurl && isRecord(subject.digest)
      && typeof subject.digest.sha512 === "string"
      && subject.digest.sha512.toLowerCase() === expectedSha512);
    const build = statement.predicate.buildDefinition;
    if (build.buildType !== "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1") return false;
    const external = isRecord(build.externalParameters) ? build.externalParameters : undefined;
    const workflow = external && isRecord(external.workflow) ? external.workflow : undefined;
    const sourceMatches = Array.isArray(build.resolvedDependencies)
      && build.resolvedDependencies.some((dependency) => isRecord(dependency) && dependency.uri === expectedSource
        && isRecord(dependency.digest) && typeof dependency.digest.gitCommit === "string"
        && /^[a-f0-9]{40}$/iu.test(dependency.digest.gitCommit));
    return subjectMatches && workflow?.repository === expectedRepository
      && workflow.path === expectedWorkflowPath && workflow.ref === expectedTag && sourceMatches;
  });
  if (!accepted) {
    throw new Error(`npm provenance is not bound to the official aTalk release workflow and tag ${expectedTag}`);
  }
}

function sha512HexFromIntegrity(integrity: string): string {
  const token = integrity.split(/\s+/u).find((value) => value.startsWith("sha512-"));
  if (!token) throw new Error("The official Gateway artifact is missing a SHA-512 integrity digest");
  const encoded = /^sha512-([^?]+)(?:\?.*)?$/u.exec(token)?.[1];
  if (!encoded) throw new Error("The official Gateway SHA-512 integrity digest is malformed");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64) throw new Error("The official Gateway SHA-512 integrity digest is malformed");
  return bytes.toString("hex");
}

function gatewayEntrypoint(directory: string): string {
  return join(directory, "node_modules", "@atalk", "gateway", "dist", "cli.js");
}

export function verifyNpmArtifactIntegrity(bytes: Buffer, integrity: string, shasum?: string): void {
  const supported = new Set(["sha512", "sha384", "sha256", "sha1"]);
  const candidates = integrity.split(/\s+/u).map((item) => /^([a-z0-9]+)-([^?]+)(?:\?.*)?$/u.exec(item))
    .filter((match): match is RegExpExecArray => Boolean(match && supported.has(match[1]!)));
  const candidate = candidates.sort((left, right) => digestRank(right[1]!) - digestRank(left[1]!))[0];
  if (!candidate) throw new Error("npm artifact has no supported Subresource Integrity digest");
  const actual = createHash(candidate[1]!).update(bytes).digest();
  const expected = Buffer.from(candidate[2]!, "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("npm artifact integrity verification failed");
  }
  if (shasum) verifyHexDigest(bytes, "sha1", shasum, "npm shasum");
}

function verifyHexDigest(bytes: Buffer, algorithm: string, expectedHex: string, label: string): void {
  if (!/^[a-f0-9]+$/iu.test(expectedHex)) throw new Error(`${label} is malformed`);
  const actual = Buffer.from(createHash(algorithm).update(bytes).digest("hex"), "utf8");
  const expected = Buffer.from(expectedHex.toLowerCase(), "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error(`${label} verification failed`);
}

function digestRank(algorithm: string): number {
  return ({ sha512: 4, sha384: 3, sha256: 2, sha1: 1 } as Record<string, number>)[algorithm] ?? 0;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(executable, [...args], { env: environment, stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectProcess(new Error(`${executable} timed out`));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectProcess(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`${executable} exited with code ${code ?? "signal"}`));
    });
  });
}

async function runJsonProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<unknown> {
  const maximumOutputBytes = 2 * 1024 * 1024;
  return new Promise<unknown>((resolveProcess, rejectProcess) => {
    const child = spawn(executable, [...args], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const settle = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProcess(error);
      else resolveProcess(value);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumOutputBytes) {
        child.kill("SIGKILL");
        settle(new Error(`${executable} JSON output exceeded ${maximumOutputBytes} bytes`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(new Error(`${executable} timed out`));
    }, timeoutMs);
    child.once("error", (error) => settle(error));
    child.once("exit", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        settle(new Error(`${executable} exited with code ${code ?? "signal"}${diagnostics ? `: ${diagnostics}` : ""}`));
        return;
      }
      try {
        settle(undefined, JSON.parse(output) as unknown);
      } catch {
        settle(new Error(`${executable} returned malformed JSON`));
      }
    });
  });
}

function parseSemver(value: string): { major: bigint; minor: bigint; patch: bigint; prerelease: string[] } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match) return undefined;
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareSemver(leftValue: string, rightValue: string): number {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) throw new Error("Cannot compare invalid semantic versions");
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (!left.prerelease.length && right.prerelease.length) return 1;
  if (left.prerelease.length && !right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/u.test(a);
    const bNumeric = /^\d+$/u.test(b);
    if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function isCompatibleUpgrade(currentValue: string, candidateValue: string): boolean {
  const current = parseSemver(currentValue);
  const candidate = parseSemver(candidateValue);
  if (!current || !candidate || compareSemver(candidateValue, currentValue) <= 0) return false;
  if (current.major > 0n) return candidate.major === current.major;
  if (candidate.major !== 0n || candidate.minor !== current.minor) return false;
  const currentLine = current.prerelease[0];
  return !currentLine || !candidate.prerelease.length || candidate.prerelease[0] === currentLine;
}

function policyAtMost(local: RuntimeUpdatePolicy, remote: RuntimeUpdatePolicy): RuntimeUpdatePolicy {
  const localRank = POLICY_RANK[local];
  const remoteRank = POLICY_RANK[remote];
  if (localRank === undefined || remoteRank === undefined) return "NOTIFY";
  return localRank <= remoteRank ? local : remote;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isRuntimeMetadata(value: unknown): value is AgentRuntimeCheckIn {
  if (!isRecord(value) || !isRecord(value.sdk) || !isRecord(value.integration)) return false;
  return typeof value.sdk.name === "string" && typeof value.sdk.version === "string"
    && typeof value.integration.name === "string" && typeof value.integration.version === "string"
    && value.protocolVersion === 1 && (value.channel === "STABLE" || value.channel === "PREVIEW")
    && Array.isArray(value.capabilities) && value.capabilities.every((item) => typeof item === "string")
    && (value.host === undefined || (isRecord(value.host) && typeof value.host.name === "string" && typeof value.host.version === "string"));
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveSleep) => {
    const timer = setTimeout(resolveSleep, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolveSleep(); }, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function offlineSelfTestEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...processExecutionEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    NO_PROXY: "*",
  };
  return environment;
}

function processExecutionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TZ"] as const) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

export function sanitizedInstallerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"] as const) {
    if (source[name]) environment[name] = source[name];
  }
  const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...environment,
    NPM_CONFIG_USERCONFIG: nullConfig,
    NPM_CONFIG_GLOBALCONFIG: nullConfig,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_ALWAYS_AUTH: "false",
  };
}

function pathIsWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

function assertOfficialRegistryUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`npm ${label} URL is malformed`);
  }
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") {
    throw new Error(`npm ${label} URL must use the official HTTPS registry`);
  }
}

async function boundedResponseBody(response: Response, maximum: number, label: string): Promise<Buffer> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel(`${label} exceeds ${maximum} bytes`).catch(() => undefined);
        throw new Error(`${label} exceeds ${maximum} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
